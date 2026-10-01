"""Synthetic signed trusted lists: never test authenticity with a mocked verifier."""
import asyncio
import base64
import io
import os
import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch
from lxml import etree
from signxml.xades import XAdESSigner
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID
from asn1crypto import x509 as asn_x509
from pyhanko.sign.validation.qualified import eutl_parse
from trust_lists import NS, checked_list, load_registry, CurrentEUTrust, download_list
from generate_fixtures import generate
from signatures import inspect_signatures


def identity(name):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    dn = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, name)])
    now = datetime.now(timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(dn).issuer_name(dn).public_key(key.public_key())
            .serial_number(x509.random_serial_number()).not_valid_before(now-timedelta(days=1))
            .not_valid_after(now+timedelta(days=365)).sign(key, hashes.SHA256()))
    return key, cert


def add(parent, name, text=None):
    child = etree.SubElement(parent, f'{{{NS}}}{name}')
    if text is not None:
        child.text = text
    return child


def digital_id(parent, cert):
    add(add(parent, 'DigitalId'), 'X509Certificate', base64.b64encode(cert.public_bytes(serialization.Encoding.DER)).decode())


def trusted_list(territory, signing_identity, ca=None, nominee=None, expires=None, service_status='granted'):
    now = datetime.now(timezone.utc)
    root = etree.Element(f'{{{NS}}}TrustServiceStatusList', nsmap={None: NS}, Id='list', TSLTag='http://uri.etsi.org/19612/TSLTag')
    scheme = add(root, 'SchemeInformation')
    add(scheme, 'TSLVersionIdentifier', '6'); add(scheme, 'TSLSequenceNumber', '1')
    add(scheme, 'SchemeTerritory', territory)
    uri = add(add(scheme, 'SchemeInformationURI'), 'URI', 'https://example.test/policy')
    uri.set('{http://www.w3.org/XML/1998/namespace}lang', 'en')
    add(scheme, 'ListIssueDateTime', (now-timedelta(minutes=1)).isoformat())
    add(add(scheme, 'NextUpdate'), 'dateTime', (expires or now+timedelta(days=1)).isoformat())
    if nominee:
        pointer = add(add(scheme, 'PointersToOtherTSL'), 'OtherTSLPointer')
        digital_id(add(add(pointer, 'ServiceDigitalIdentities'), 'ServiceDigitalIdentity'), nominee)
        add(pointer, 'TSLLocation', 'https://example.test/PL.xml')
        info = add(pointer, 'AdditionalInformation')
        add(add(info, 'OtherInformation'), 'SchemeTerritory', 'PL')
        etree.SubElement(add(info, 'OtherInformation'), '{http://uri.etsi.org/02231/v2/additionaltypes#}MimeType').text = 'application/vnd.etsi.tsl+xml'
    if ca:
        services = add(add(add(root, 'TrustServiceProviderList'), 'TrustServiceProvider'), 'TSPServices')
        service = add(add(services, 'TSPService'), 'ServiceInformation')
        add(service, 'ServiceTypeIdentifier', 'http://uri.etsi.org/TrstSvc/Svctype/CA/QC')
        name = add(add(service, 'ServiceName'), 'Name', 'Fixture document CA')
        name.set('{http://www.w3.org/XML/1998/namespace}lang', 'en')
        digital_id(add(service, 'ServiceDigitalIdentity'), ca)
        add(service, 'ServiceStatus', f'http://uri.etsi.org/TrstSvc/TrustedList/Svcstatus/{service_status}')
        add(service, 'StatusStartingTime', (now-timedelta(days=1)).isoformat())
    key, cert = signing_identity
    signed = XAdESSigner().sign(root, key=key, cert=[cert], reference_uri='#list')
    return etree.tostring(signed).decode()


class SignedTrustLists(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.anchor = identity('LOTL signer fixture')
        cls.national = identity('National list signer fixture')
        cls.untrusted = identity('Other list signer fixture')
        cls.work = tempfile.TemporaryDirectory()
        cls.generated = generate(Path(cls.work.name)/'documents')
        cls.ca = x509.load_pem_x509_certificate((cls.generated/'root.pem').read_bytes())
        cls.lotl = trusted_list('EU', cls.anchor, nominee=cls.national[1])
        cls.pl = trusted_list('PL', cls.national, ca=cls.ca)
        cls.anchor_asn = asn_x509.Certificate.load(cls.anchor[1].public_bytes(serialization.Encoding.DER))
        cls.national_asn = asn_x509.Certificate.load(cls.national[1].public_bytes(serialization.Encoding.DER))

    @classmethod
    def tearDownClass(cls):
        cls.work.cleanup()

    def test_real_xml_signature_and_bound_signed_payload(self):
        signed, meta = checked_list(self.pl, [self.national_asn], 'PL')
        self.assertEqual(meta['sequence'], 1)
        registry, errors = eutl_parse.trust_list_to_registry_unsafe(signed)
        self.assertEqual(errors, [])
        self.assertTrue(CurrentEUTrust(registry).is_root(asn_x509.Certificate.load(self.ca.public_bytes(serialization.Encoding.DER))))
        with self.assertRaises(Exception):
            checked_list(self.pl.replace('Fixture document CA', 'Forged document CA'), [self.national_asn], 'PL')
        with self.assertRaises(Exception):
            checked_list(self.pl, [self.anchor_asn], 'PL')
        with self.assertRaises(Exception):
            checked_list(self.pl, [self.national_asn], 'DE')

    def test_expired_signed_list_and_xml_entity_are_rejected(self):
        expired = trusted_list('PL', self.national, ca=self.ca, expires=datetime.now(timezone.utc)-timedelta(seconds=1))
        with self.assertRaises(ValueError):
            checked_list(expired, [self.national_asn], 'PL')
        with self.assertRaises(ValueError):
            checked_list('<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]>'+self.pl, [self.national_asn], 'PL')
        withdrawn = trusted_list('PL', self.national, ca=self.ca, service_status='withdrawn')
        signed, _ = checked_list(withdrawn, [self.national_asn], 'PL')
        registry, _ = eutl_parse.trust_list_to_registry_unsafe(signed)
        self.assertFalse(CurrentEUTrust(registry).is_root(asn_x509.Certificate.load(self.ca.public_bytes(serialization.Encoding.DER))))

    def test_two_tier_authentication_rejects_self_nominated_root_and_old_cache(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {'PDF_SIGNATURE_EUTL_CACHE': directory, 'PDF_SIGNATURE_EUTL': 'true'}), patch.object(eutl_parse, 'latest_known_lotl_tlso_certs', return_value=[self.anchor_asn]):
            root = Path(directory)
            (root/'EU.xml').write_text(self.lotl); (root/'PL.xml').write_text(self.pl)
            registry, status = load_registry({'PL'})
            self.assertEqual(status['status'], 'ready', status)
            self.assertEqual(len(registry.known_certificate_authorities), 1)
            from trust_lists import persist_list
            persist_list(root, self.pl, {'territory': 'PL', 'sequence': 2, 'issuedAt': status['lists'][0]['issuedAt']})
            self.assertEqual(load_registry({'PL'})[1]['status'], 'unavailable', 'An interrupted newer update must not expose older XML as current')
            (root/'PL.sequence.json').unlink()
            (root/'PL.xml').write_text(trusted_list('PL', self.untrusted, ca=self.ca))
            registry, status = load_registry({'PL'})
            self.assertEqual(len(registry.known_certificate_authorities), 0)
            self.assertEqual(status['unavailableTerritories'], ['PL'])
            (root/'PL.xml').write_text(self.pl)
            old = time.time()-90000; os.utime(root/'PL.xml', (old, old))
            self.assertEqual(load_registry({'PL'})[1]['status'], 'unavailable')

    def test_pdf_uses_authenticated_service_root_and_separates_missing_revocation(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {'PDF_SIGNATURE_EUTL_CACHE': directory, 'PDF_SIGNATURE_EUTL': 'true', 'PDF_SIGNATURE_ONLINE': 'false', 'PDF_SIGNATURE_TRUST_ROOTS': '', 'PDF_SIGNATURE_REVOCATION_DIR': str(self.generated/'good')}), patch.object(eutl_parse, 'latest_known_lotl_tlso_certs', return_value=[self.anchor_asn]):
            root=Path(directory); (root/'EU.xml').write_text(self.lotl); (root/'PL.xml').write_text(self.pl)
            data=(self.generated/'signed.pdf').read_bytes()
            report=asyncio.run(inspect_signatures(data))['json']; item=report['signatures'][0]
            self.assertEqual(report['status'], 'valid', report)
            self.assertEqual(item['trustSource'], 'eu-trusted-lists')
            self.assertEqual(len(item['chain']), 2)
            self.assertEqual(item['timestamp'], 'absent')
            with patch.dict(os.environ, {'PDF_SIGNATURE_REVOCATION_DIR': ''}):
                report=asyncio.run(inspect_signatures(data))['json']; item=report['signatures'][0]
                self.assertEqual(report['status'], 'unknown', report)
                self.assertEqual(item['trust'], 'valid')
                self.assertEqual(item['revocation'], 'unknown')
                self.assertEqual(item['diagnostic'], 'REVOCATION_OFFLINE')

    def test_persistent_sequence_prevents_rollback_without_using_cache_mtime(self):
        from trust_lists import persist_list
        now = datetime.now(timezone.utc)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            meta = {'territory': 'PL', 'sequence': 20, 'issuedAt': now.isoformat()}
            persist_list(root, self.pl, meta)
            with self.assertRaisesRegex(ValueError, 'ROLLBACK'):
                persist_list(root, self.pl, meta | {'sequence': 19})
            with self.assertRaisesRegex(ValueError, 'ROLLBACK'):
                persist_list(root, self.pl, meta | {'issuedAt': (now-timedelta(days=1)).isoformat()})
            self.assertEqual((root/'PL.xml').read_text(), self.pl)


class PublicListRedirects(unittest.IsolatedAsyncioTestCase):
    async def test_each_redirect_is_an_explicit_request_and_downgrades_are_rejected(self):
        from unittest.mock import MagicMock
        class Response:
            def __init__(self, status, location=None):
                self.status = status; self.headers = {'Location': location} if location else {}
            async def __aenter__(self): return self
            async def __aexit__(self, *args): return None
            def raise_for_status(self): return None
            async def read(self): return b'<verified-later/>'
        client = MagicMock()
        client.get.side_effect = [Response(302, 'https://b.example.test/list'), Response(200)]
        self.assertEqual(await download_list(client, 'https://a.example.test/list'), '<verified-later/>')
        self.assertEqual([call.args[0] for call in client.get.call_args_list], ['https://a.example.test/list', 'https://b.example.test/list'])
        self.assertTrue(all(call.kwargs['allow_redirects'] is False for call in client.get.call_args_list))
        client.get.reset_mock(); client.get.side_effect = [Response(302, 'http://b.example.test/list')]
        with self.assertRaises(ValueError): await download_list(client, 'https://a.example.test/list')
        self.assertEqual(client.get.call_count, 1)
        client.get.side_effect = [Response(302, '/loop') for _ in range(4)]
        with self.assertRaises(ValueError): await download_list(client, 'https://a.example.test/list')
