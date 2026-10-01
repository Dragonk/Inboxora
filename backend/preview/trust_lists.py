"""Signed EU trust lists. Only the updater writes this cache; PDF workers only read.

The pinned pyHanko adapter returns exactly the XML covered by the validated
signature. Never parse an unverified list into trust roots or accept the TLS
connection itself as proof of trust-list authenticity.
"""
import asyncio
import fcntl
import json
import os
import re
import time
import tempfile
from datetime import datetime, timezone, timedelta
from pathlib import Path
from urllib.parse import urljoin, urlsplit
from lxml import etree
from pyhanko.sign.validation.qualified import eutl_parse
from pyhanko.sign.validation.qualified.eutl_fetch import EU_LOTL_LOCATION
from pyhanko.sign.validation.qualified.tsp import TSPRegistry, TSPTrustManager, CAServiceInformation, QTSTServiceInformation
from pyhanko_certvalidator.registry import TrustManager, SimpleTrustManager
from public_network import certificate_session

NS = 'http://uri.etsi.org/02231/v2#'
MAX_LIST = 16 * 1024 * 1024
MAX_CACHE_AGE = 24 * 60 * 60
MAX_LISTS = 40


def cache_directory():
    return Path(os.getenv('PDF_SIGNATURE_EUTL_CACHE') or '/tmp/inboxora-eutl')


def enabled():
    return os.getenv('PDF_SIGNATURE_EUTL', 'true').lower() == 'true'


def read_list(path):
    if path.is_symlink():
        raise ValueError('TRUST_LIST_UNAVAILABLE')
    with path.open('rb') as stream:
        data = stream.read(MAX_LIST + 1)
        age = time.time() - os.fstat(stream.fileno()).st_mtime
    if len(data) > MAX_LIST or (age < -300 or age > MAX_CACHE_AGE):
        raise ValueError('TRUST_LIST_STALE')
    return data.decode('utf-8-sig')


def checked_list(xml, signers, territory, now=None):
    if len(xml.encode('utf-8')) > MAX_LIST or re.search(r'<!\s*(?:DOCTYPE|ENTITY)', xml, re.I):
        raise ValueError('TRUST_LIST_INVALID')
    # This internal adapter is pinned to pyHanko 0.37 and regression tested with
    # signed lists. Public registry APIs do not expose signed freshness metadata.
    signed = eutl_parse._validate_and_extract_tl_data_multiple_certs(xml, signers, validation_time=None)
    root = etree.fromstring(signed.encode(), parser=etree.XMLParser(resolve_entities=False, no_network=True, load_dtd=False))
    if root.tag != f'{{{NS}}}TrustServiceStatusList':
        raise ValueError('TRUST_LIST_INVALID')
    scheme = root.find(f'{{{NS}}}SchemeInformation')
    if scheme is None or scheme.findtext(f'{{{NS}}}SchemeTerritory') != territory:
        raise ValueError('TRUST_LIST_INVALID')
    def date(path):
        value = datetime.fromisoformat(scheme.findtext(path).replace('Z', '+00:00'))
        if value.tzinfo is None:
            raise ValueError('TRUST_LIST_INVALID')
        return value
    issued = date(f'{{{NS}}}ListIssueDateTime')
    expires = date(f'{{{NS}}}NextUpdate/{{{NS}}}dateTime')
    now = now or datetime.now(timezone.utc)
    if issued > now + timedelta(minutes=5) or expires <= now or expires <= issued:
        raise ValueError('TRUST_LIST_STALE')
    sequence = int(scheme.findtext(f'{{{NS}}}TSLSequenceNumber'))
    if sequence < 0:
        raise ValueError('TRUST_LIST_INVALID')
    return signed, {'territory': territory, 'issuedAt': issued.isoformat(), 'nextUpdate': expires.isoformat(), 'sequence': sequence}


def lotl_references(xml):
    signed, meta = checked_list(xml, eutl_parse.latest_known_lotl_tlso_certs(), 'EU')
    parsed = eutl_parse.parse_lotl_unsafe(signed)
    refs = [ref for ref in parsed.references if eutl_parse.LOTL_RULE not in ref.scheme_rules]
    if parsed.errors or len(refs) > MAX_LISTS or any(not re.fullmatch('[A-Z]{2}', ref.territory) for ref in refs):
        raise ValueError('TRUST_LIST_INVALID')
    if len({ref.territory for ref in refs}) != len(refs):
        raise ValueError('TRUST_LIST_INVALID')
    return refs, meta


class CurrentEUTrust(TSPTrustManager):
    """Do not turn historical or withdrawn service identities into current roots."""
    def as_trust_anchor(self, authority):
        now = datetime.now(timezone.utc)
        if not any(self.tsp_registry.applicable_service_definitions(authority, now)):
            return None
        anchor = super().as_trust_anchor(authority)
        if anchor is None:
            return None
        quals = anchor.trust_qualifiers
        if quals.valid_from and quals.valid_from > now or quals.valid_until and quals.valid_until < now:
            return None
        return anchor


class DocumentTrust(TrustManager):
    def __init__(self, registry, extra_roots=(), fallback=None):
        self.fallback = fallback
        self.generation = 0
        self.eu = CurrentEUTrust(registry)
        self.configured = SimpleTrustManager.build(trust_roots=extra_roots)

    def as_trust_anchor(self, authority):
        return self.eu.as_trust_anchor(authority) or self.configured.as_trust_anchor(authority)

    def find_potential_issuers(self, cert):
        candidates = list(self.eu.find_potential_issuers(cert)) + list(self.configured.find_potential_issuers(cert))
        if not candidates and self.fallback:
            self.load_all()
            candidates = list(self.eu.find_potential_issuers(cert)) + list(self.configured.find_potential_issuers(cert))
        yield from candidates

    def load_all(self):
        if not self.fallback:
            return False
        load, self.fallback = self.fallback, None
        self.eu = CurrentEUTrust(load())
        self.generation += 1
        return True

    def source(self, authority):
        return 'eu-trusted-lists' if self.eu.as_trust_anchor(authority) else 'configured'


def load_registry(territories=None):
    registry = TSPRegistry()
    info = {'status': 'disabled' if not enabled() else 'unavailable', 'lists': [], 'unavailableTerritories': []}
    if not enabled():
        return registry, info
    directory = cache_directory()
    try:
        refs, meta = lotl_references(read_list(directory/'EU.xml'))
        enforce_watermark(directory, meta)
        info.update(meta)
    except Exception:
        return registry, info
    # Country hints only optimise local parsing, never confer trust. Include
    # all lists when the document does not identify an available jurisdiction.
    known = {ref.territory for ref in refs}
    selected = known & set(territories or ())
    for ref in refs:
        if selected and ref.territory not in selected:
            continue
        try:
            signed, meta = checked_list(read_list(directory/f'{ref.territory}.xml'), ref.tlso_certs, ref.territory)
            enforce_watermark(directory, meta)
            temporary, errors = eutl_parse.trust_list_to_registry_unsafe(signed)
            # Unsupported service types may be reported by the library; it only
            # registers parsed CA/QC and QTST services, never the rejected ones.
            for authority in temporary.known_certificate_authorities:
                for service in temporary.applicable_service_definitions(authority, None):
                    if isinstance(service, CAServiceInformation):
                        registry.register_ca(service)
            for authority in temporary.known_timestamp_authorities:
                for service in temporary.applicable_service_definitions(authority, None):
                    if isinstance(service, QTSTServiceInformation):
                        registry.register_tst(service)
            info['lists'].append(meta | {'partial': bool(errors)})
        except Exception:
            info['unavailableTerritories'].append(ref.territory)
    info['status'] = 'ready' if info['lists'] and not info['unavailableTerritories'] and not any(item['partial'] for item in info['lists']) else 'partial' if info['lists'] else 'unavailable'
    return registry, info


def atomic_write(path, data):
    # Random sibling avoids following a pre-created .tmp symlink.
    descriptor, temporary = tempfile.mkstemp(prefix='.refresh-', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def enforce_watermark(directory, meta):
    watermark = directory/f"{meta['territory']}.sequence.json"
    if not watermark.exists():
        return
    if watermark.is_symlink():
        raise ValueError('TRUST_LIST_INVALID')
    with watermark.open('rb') as stream:
        encoded = stream.read(4097)
    if len(encoded) > 4096:
        raise ValueError('TRUST_LIST_INVALID')
    previous = json.loads(encoded)
    if (meta['sequence'] < previous['sequence']
            or datetime.fromisoformat(meta['issuedAt']) < datetime.fromisoformat(previous['issuedAt'])):
        raise ValueError('TRUST_LIST_ROLLBACK')


def persist_list(directory, xml, meta):
    target = directory/f"{meta['territory']}.xml"
    watermark = directory/f"{meta['territory']}.sequence.json"
    enforce_watermark(directory, meta)
    # Advancing the high-water mark first may cause a retry after interruption,
    # but can never permit rollback. No document or private key is cached here.
    atomic_write(watermark, json.dumps({'sequence': meta['sequence'], 'issuedAt': meta['issuedAt']}).encode())
    atomic_write(target, xml.encode('utf-8'))


async def download_list(client, url):
    # Only trust-list discovery follows bounded redirects. Each hop is a new
    # request through the public-address resolver; XML authenticity is still
    # checked against the LOTL-nominated key, never the redirected site's TLS.
    for _ in range(4):
        async with client.get(url, allow_redirects=False) as response:
            if response.status in (301, 302, 303, 307, 308):
                location = response.headers.get('Location')
                if not location:
                    raise ValueError('TRUST_LIST_UNAVAILABLE')
                target = urljoin(url, location)
                if urlsplit(url).scheme == 'https' and urlsplit(target).scheme != 'https':
                    raise ValueError('TRUST_LIST_REDIRECT')
                url = target
                continue
            response.raise_for_status()
            return (await response.read()).decode('utf-8-sig')
    raise ValueError('TRUST_LIST_REDIRECT')


async def refresh():
    if not enabled() or os.getenv('PDF_SIGNATURE_ONLINE', 'true').lower() != 'true':
        return {'status': 'disabled'}
    directory = cache_directory()
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    if directory.is_symlink():
        raise ValueError('TRUST_LIST_INVALID')
    # Independent of HTTP requests and resistant to simultaneous replica starts.
    with (directory/'refresh.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return {'status': 'busy'}
        async with certificate_session(response_limit=MAX_LIST, total_limit=128*1024*1024, request_limit=2*MAX_LISTS+4, timeout=12) as client:
            xml = await download_list(client, EU_LOTL_LOCATION)
            refs, meta = lotl_references(xml)
            persist_list(directory, xml, meta)
            result = {'status': 'ready', 'checkedAt': datetime.now(timezone.utc).isoformat(), 'updated': [], 'failed': []}
            semaphore = asyncio.Semaphore(3)
            async def country(ref):
                async with semaphore:
                    try:
                        data = await download_list(client, ref.location_uri)
                        signed, details = checked_list(data, ref.tlso_certs, ref.territory)
                        eutl_parse.trust_list_to_registry_unsafe(signed)
                        persist_list(directory, data, details)
                        result['updated'].append(ref.territory)
                    except Exception:
                        result['failed'].append(ref.territory)
            await asyncio.gather(*(country(ref) for ref in refs))
            if result['failed']:
                result['status'] = 'partial'
            atomic_write(directory/'status.json', json.dumps(result).encode())
            return result


if __name__ == '__main__':
    import resource
    import logging
    logging.disable(logging.CRITICAL)
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_AS, (768*1024*1024, 768*1024*1024))
    resource.setrlimit(resource.RLIMIT_CPU, (60, 60))
    resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_LIST, MAX_LIST))
    try:
        print(json.dumps(asyncio.run(asyncio.wait_for(refresh(), timeout=110))))
    except Exception:
        print(json.dumps({'status': 'unavailable'}))
        raise SystemExit(1)
