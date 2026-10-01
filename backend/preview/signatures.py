"""Validate PDF/CMS integrity, trust and current revocation status separately."""
import asyncio
import hashlib
import io
import os
from datetime import datetime, timezone
from pathlib import Path
from asn1crypto import pem, x509, crl
from pyhanko.pdf_utils.reader import PdfFileReader
from pyhanko.pdf_utils.generic import pdf_string
from pyhanko.sign.fields import enumerate_sig_fields
from pyhanko.sign.validation import async_validate_pdf_signature
from pyhanko.sign.validation.dss import DocumentSecurityStore, NoDSSFoundError
from pyhanko.sign.validation.pdf_embedded import EmbeddedPdfSignature
from pyhanko.sign.validation.settings import KeyUsageConstraints
from pyhanko_certvalidator import ValidationContext, CertificateValidator
from pyhanko_certvalidator.policy_decl import CertRevTrustPolicy, RevocationCheckingPolicy, RevocationCheckingRule
from trust_lists import load_registry, DocumentTrust
from pyhanko_certvalidator.fetchers.aiohttp_fetchers import AIOHttpFetcherBackend
from public_network import certificate_session


def text(value):
    # ByteStringObject must be decoded, not displayed as Python's b'...' repr.
    if value is None:
        return ''
    if isinstance(value, (bytes, bytearray)):
        raw = bytes(value)
        if raw.startswith((bytes.fromhex('feff'), bytes.fromhex('fffe'))):
            value = raw.decode('utf-16', errors='replace')
        else:
            try:
                value = raw.decode('utf-8-sig')
            except UnicodeDecodeError:
                decoded = pdf_string(raw)
                value = decoded if isinstance(decoded, str) else raw.decode('cp1252', errors='replace')
    # Preserve real newlines; do not evaluate literal escapes or document HTML.
    value = str(value).replace('\r\n', '\n').replace('\r', '\n')
    return ''.join(c for c in value if c in '\n\t' or ord(c) >= 32 and ord(c) != 127)[:2048]


def certificates(path):
    with Path(path).open('rb') as stream:
        data = stream.read(2 * 1024 * 1024 + 1)
    if len(data) > 2 * 1024 * 1024:
        raise ValueError('LIMIT')
    if pem.detect(data):
        return [x509.Certificate.load(item[2]) for item in pem.unarmor(data, multiple=True) if item[0] == 'CERTIFICATE']
    return [x509.Certificate.load(data)]


def certificate_details(cert):
    subject = cert.subject.native
    validity = cert['tbs_certificate']['validity']
    return {key: text(subject.get(source)) for key, source in {
        'commonName': 'common_name', 'givenName': 'given_name', 'surname': 'surname',
        'organization': 'organization_name', 'country': 'country_name', 'email': 'email_address',
    }.items()} | {
        'subject': cert.subject.human_friendly, 'issuer': cert.issuer.human_friendly,
        'serial': format(cert.serial_number, 'X'), 'fingerprint': hashlib.sha256(cert.dump()).hexdigest(),
        'validFrom': validity['not_before'].native.isoformat(), 'validTo': validity['not_after'].native.isoformat(),
    }


def local_revocation():
    directory = os.getenv('PDF_SIGNATURE_REVOCATION_DIR')
    if not directory:
        return []
    paths = sorted(Path(directory).glob('*.crl'))
    if len(paths) > 50:
        raise ValueError('LIMIT')
    result, total = [], 0
    for path in paths:
        with path.open('rb') as stream:
            data = stream.read(2 * 1024 * 1024 + 1)
        total += len(data)
        if len(data) > 2 * 1024 * 1024 or total > 8 * 1024 * 1024:
            raise ValueError('LIMIT')
        if pem.detect(data):
            data = pem.unarmor(data)[2]
        result.append(crl.CertificateList.load(data))
    return result


def page_numbers(reader):
    found, seen = {}, set()
    stack = [reader.root.raw_get('/Pages')]
    number = 0
    while stack:
        item = stack.pop()
        ref = getattr(item, 'reference', None)
        if ref in seen:
            raise ValueError('CORRUPT')
        if ref is not None:
            seen.add(ref)
        page = item.get_object()
        if page.get('/Type') == '/Pages':
            children = list(page.get('/Kids', []))
            if len(children) > 2000 or len(seen) > 4000:
                raise ValueError('LIMIT')
            stack.extend(reversed(children))
        else:
            number += 1
            if number > 2000:
                raise ValueError('LIMIT')
            for annotation in page.get('/Annots', []):
                key = getattr(annotation, 'reference', None)
                if key is not None:
                    found[key] = number
    return found


def result_for_status(status, certificate):
    coverage = getattr(status.coverage, 'name', 'UNKNOWN')
    modification = getattr(status.modification_level, 'name', 'UNKNOWN')
    # Require revocation information for the signer, not only a trusted self-signed root.
    path = status.validation_path
    trusted_chain = status.trusted and path is not None and len(path) > 1
    reason = getattr(status.trust_problem_indic, 'name', '')
    crypto_ok = status.intact and status.valid
    timestamps = [value for value in (status.timestamp_validity, status.content_timestamp_validity) if value is not None]
    timestamp_invalid = any(not value.valid or not value.intact or value.revoked for value in timestamps)
    rejected = (timestamp_invalid or not crypto_ok or status.revoked or coverage not in ('ENTIRE_FILE', 'ENTIRE_REVISION')
                or modification == 'OTHER' or status.docmdp_ok is False)
    now = datetime.now(timezone.utc)
    if now < datetime.fromisoformat(certificate['validFrom']) or now > datetime.fromisoformat(certificate['validTo']):
        rejected = True
        reason = 'CERTIFICATE_TIME'
    result = 'invalid' if rejected else 'valid' if trusted_chain and status.bottom_line else 'unknown'
    return {'status': result, 'integrity': 'valid' if crypto_ok else 'invalid',
            'trust': 'valid' if trusted_chain else 'unknown',
            'revocation': 'revoked' if status.revoked else 'checked' if trusted_chain else 'unknown',
            'coverage': coverage, 'modification': modification, 'diagnostic': reason,
            'digestAlgorithm': status.md_algorithm, 'signatureAlgorithm': status.pkcs7_signature_mechanism,
            'timestamp': 'invalid' if timestamp_invalid else 'valid' if status.timestamp_validity and status.timestamp_validity.trusted else 'absent' if not timestamps else 'unknown'}


async def inspect_signatures(data):
    report = {'checkedAt': datetime.now(timezone.utc).isoformat(), 'status': 'unknown', 'signatures': [],
              'policy': 'current-time', 'trustSource': 'eu-trusted-lists+configured' if os.getenv('PDF_SIGNATURE_TRUST_ROOTS') else 'eu-trusted-lists'}
    reader = PdfFileReader(io.BytesIO(data), strict=True)
    if reader.encrypted:
        return {'json': report | {'diagnostic': 'ENCRYPTED_PDF'}}
    fields = []
    for field in enumerate_sig_fields(reader):
        if len(fields) >= 50:
            raise ValueError('LIMIT')
        fields.append(field)
    if not fields:
        return {'json': report | {'diagnostic': 'UNSIGNED'}}
    pages = page_numbers(reader)
    configured = os.getenv('PDF_SIGNATURE_TRUST_ROOTS')
    roots = certificates(configured) if configured else []
    # Country hints only select the first local XML files to parse. Actual trust
    # comes from authenticated service keys; a missing issuer loads all lists.
    territories = set()
    embedded_fields = {}
    for name, value, ref in fields:
        if value is None:
            continue
        try:
            embedded = EmbeddedPdfSignature(reader, ref, name)
            embedded_fields[name] = embedded
            for cert in [embedded.signer_cert, *embedded.other_embedded_certs]:
                for dn in (cert.subject, cert.issuer):
                    country = dn.native.get('country_name')
                    if isinstance(country, str) and len(country) == 2:
                        territories.add(country.upper())
        except (MemoryError, RecursionError):
            raise ValueError('LIMIT') from None
        except Exception:
            pass  # A malformed field gets its own diagnostic below.
    registry, lists = load_registry(territories)
    report['trustLists'] = lists
    def all_lists():
        registry, complete = load_registry()
        lists.clear(); lists.update(complete)
        return registry
    trust = DocumentTrust(registry, roots, fallback=all_lists if territories else None)
    crls = local_revocation()
    online = os.getenv('PDF_SIGNATURE_ONLINE', 'true').lower() == 'true'
    network = []
    async with certificate_session(diagnostics=network) as session:
        context_args = dict(trust_manager=trust, crls=crls, revocation_mode='require', allow_fetching=online,
                            fetcher_backend=AIOHttpFetcherBackend(session, per_request_timeout=5))
        def make_context(arguments):
            try:
                return DocumentSecurityStore.read_dss(reader).as_validation_context(arguments)
            except NoDSSFoundError:
                return ValidationContext(**arguments)
        context = make_context(context_args)
        # NO_CHECK is used ONLY to explain whether the cryptographic path exists.
        # Its result can never turn the overall signature/revocation status green.
        path_context = make_context(context_args | {'revinfo_policy': CertRevTrustPolicy(
            RevocationCheckingPolicy(RevocationCheckingRule.NO_CHECK, RevocationCheckingRule.NO_CHECK))})
        for name, value, ref in fields:
            network.clear()
            item = {'field': text(name), 'page': pages.get(getattr(ref, 'reference', None)),
                    'status': 'unknown', 'integrity': 'unknown', 'trust': 'unknown', 'revocation': 'unknown'}
            if value is None:
                item['diagnostic'] = 'EMPTY_FIELD'
                report['signatures'].append(item)
                continue
            try:
                embedded = embedded_fields.get(name) or EmbeddedPdfSignature(reader, ref, name)
                cert = certificate_details(embedded.signer_cert)
                sig = embedded.sig_object
                item.update(certificate=cert, signer=cert['commonName'] or cert['subject'],
                            claimedSigner=text(sig.get('/Name')), reason=text(sig.get('/Reason')),
                            location=text(sig.get('/Location')), contact=text(sig.get('/ContactInfo')),
                            claimedTime=text(embedded.self_reported_timestamp.isoformat() if embedded.self_reported_timestamp else None),
                            subFilter=text(sig.get('/SubFilter')), byteRange=list(embedded.byte_range),
                            signedRevision=embedded.signed_revision + 1)
                # No EKU extension means no EKU restriction (RFC 5280). pyHanko
                # 0.37 rebuilds usage settings and drops the explicit-EKU flag,
                # so select an EKU constraint only when that extension exists.
                eku = None if embedded.signer_cert.extended_key_usage_value is None else {
                    x509.KeyPurposeId(oid).native for oid in ('1.3.6.1.5.5.7.3.36', '1.2.840.113583.1.1.5', '2.5.29.37.0')}
                usage = KeyUsageConstraints(key_usage={'digital_signature', 'non_repudiation'}, extd_key_usage=eku)
                generation = trust.generation
                status = await async_validate_pdf_signature(embedded, signer_validation_context=context,
                    ts_validation_context=context, key_usage_settings=usage)
                timestamps = [value for value in (status.timestamp_validity, status.content_timestamp_validity) if value is not None]
                incomplete_path = not status.trusted or any(not value.trusted for value in timestamps)
                if incomplete_path and (trust.load_all() or trust.generation != generation):
                    # Country hints must not prevent cross-border chains or a
                    # directly trusted foreign TSA. Retry once with all lists
                    # and a fresh path-building cache, never a relaxed policy.
                    context = make_context(context_args)
                    path_context = make_context(context_args | {'revinfo_policy': CertRevTrustPolicy(
                        RevocationCheckingPolicy(RevocationCheckingRule.NO_CHECK, RevocationCheckingRule.NO_CHECK))})
                    status = await async_validate_pdf_signature(embedded, signer_validation_context=context,
                        ts_validation_context=context, key_usage_settings=usage)
                item.update(result_for_status(status, cert))
                path = status.validation_path if status.trusted else None
                if path is None:
                    try:
                        # Path signatures, validity, name constraints and allowed
                        # document-signing usages are checked independently of CRL.
                        usage.validate(embedded.signer_cert)
                        path = await CertificateValidator(embedded.signer_cert,
                            intermediate_certs=embedded.other_embedded_certs, validation_context=path_context).async_validate_path()
                        if len(path) > 1:
                            item['trust'] = 'valid'
                    except (MemoryError, RecursionError):
                        raise ValueError('LIMIT') from None
                    except Exception:
                        path = None
                if path is not None and len(path) <= 12:
                    item['chain'] = [certificate_details(value) for value in reversed(list(path))]
                    item['trustSource'] = trust.source(path.trust_anchor.authority)
                item['network'] = list(network)
                if item['status'] != 'valid' and item['diagnostic'] not in ('CERTIFICATE_TIME', 'CHAIN_CONSTRAINTS_FAILURE'):
                    if item['trust'] == 'valid' and item['revocation'] == 'unknown':
                        item['diagnostic'] = 'REVOCATION_UNAVAILABLE' if online else 'REVOCATION_OFFLINE'
                    elif item['trust'] == 'unknown' and not roots and lists['status'] in ('unavailable', 'disabled'):
                        item['diagnostic'] = 'TRUST_LIST_UNAVAILABLE'
                    elif item['trust'] == 'unknown' and not item['diagnostic']:
                        item['diagnostic'] = 'NO_TRUST_ANCHOR'
            except (MemoryError, RecursionError):
                raise ValueError('LIMIT') from None
            except Exception:
                # Unsupported cryptography, malformed CMS and unavailable trust evidence never become green.
                if item['status'] != 'invalid':
                    item['status'] = 'unknown'
                item['diagnostic'] = 'VALIDATION_UNAVAILABLE'
            report['signatures'].append(item)
    statuses = [item['status'] for item in report['signatures']]
    report['status'] = 'invalid' if 'invalid' in statuses else 'valid' if statuses and all(value == 'valid' for value in statuses) else 'unknown'
    return {'json': report}
