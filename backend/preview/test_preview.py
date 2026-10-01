import asyncio
import json
import os
import socket
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from generate_fixtures import generate
from public_network import public_ip, PublicResolver

HERE = Path(__file__).resolve().parent
FIXTURES = HERE.parent/'fixtures'/'attachments'

class PreviewIntegration(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix='inboxora-preview-fixtures-')
        cls.generated = generate(cls.temporary.name)

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def run_file(self, name, action='signatures', revoked=False, trust=True, **fields):
        source = self.generated/name
        if not source.exists():
            source = FIXTURES/name
        original = source.read_bytes()
        env = {'PATH': os.environ.get('PATH', ''), 'LANG': 'C.UTF-8', 'PDF_SIGNATURE_ONLINE': 'false',
               'PDF_SIGNATURE_REVOCATION_DIR': str(self.generated/('revoked' if revoked else 'good'))}
        if trust:
            env['PDF_SIGNATURE_TRUST_ROOTS'] = str(self.generated/'root.pem')
        result = subprocess.run([sys.executable, '-B', str(HERE/'process.py')],
            input=json.dumps(dict(action=action, filename=name, **fields)).encode()+b'\n'+original,
            capture_output=True, timeout=35, env=env)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        header, payload = result.stdout.split(b'\n', 1)
        report = json.loads(header)
        self.assertEqual(source.read_bytes(), original, 'Processing must not mutate original bytes')
        self.assertEqual(report.get('byteLength', 0), len(payload))
        return report, payload

    def test_real_signature_integrity_chain_and_revocation(self):
        result, _ = self.run_file('signed.pdf')
        self.assertNotIn('error', result, result)
        report = result['json']; self.assertEqual(report['status'], 'valid', report)
        signature = report['signatures'][0]
        self.assertEqual(signature['integrity'], 'valid')
        self.assertEqual(signature['revocation'], 'checked')
        self.assertEqual(signature['certificate']['commonName'], 'Inboxora synthetic signer')
        self.assertEqual(signature['certificate']['email'], 'fixture@example.test')
        self.assertEqual(signature['page'], 1)

    def test_byte_tampering_is_red(self):
        report = self.run_file('tampered.pdf')[0]['json']
        self.assertEqual(report['status'], 'invalid', report)
        self.assertEqual(report['signatures'][0]['integrity'], 'invalid')

    def test_revoked_certificate_is_red(self):
        report = self.run_file('signed.pdf', revoked=True)[0]['json']
        self.assertEqual(report['status'], 'invalid', report)
        self.assertEqual(report['signatures'][0]['revocation'], 'revoked')

    def test_untrusted_certificate_is_yellow_not_green(self):
        report = self.run_file('signed.pdf', trust=False)[0]['json']
        self.assertEqual(report['status'], 'unknown', report)
        self.assertEqual(report['signatures'][0]['integrity'], 'valid')

    def test_server_authentication_certificate_is_not_a_document_signer(self):
        report = self.run_file('tls-only.pdf')[0]['json']
        self.assertEqual(report['status'], 'unknown', report)
        self.assertEqual(report['signatures'][0]['integrity'], 'valid')
        self.assertEqual(report['signatures'][0]['diagnostic'], 'CHAIN_CONSTRAINTS_FAILURE')

    def test_expired_certificate_is_red_under_current_time_policy(self):
        report = self.run_file('expired.pdf')[0]['json']
        self.assertEqual(report['status'], 'invalid', report)
        self.assertEqual(report['signatures'][0]['diagnostic'], 'CERTIFICATE_TIME')

    def test_multiple_incremental_signatures(self):
        report = self.run_file('signed-twice.pdf')[0]['json']
        self.assertEqual(len(report['signatures']), 2)
        self.assertEqual(report['status'], 'valid', report)
        self.assertEqual(report['signatures'][0]['coverage'], 'ENTIRE_REVISION')
        self.assertEqual(report['signatures'][1]['coverage'], 'ENTIRE_FILE')

    def test_empty_field_and_password_are_not_valid_signatures(self):
        report = self.run_file('empty-signature.pdf')[0]['json']
        self.assertEqual(report['status'], 'unknown')
        self.assertEqual(report['signatures'][0]['diagnostic'], 'EMPTY_FIELD')
        encrypted = self.run_file('password.pdf')[0]['json']
        self.assertEqual(encrypted['status'], 'unknown')
        self.assertEqual(encrypted['diagnostic'], 'ENCRYPTED_PDF')

    def test_every_native_archive_and_selected_bytes(self):
        for name in ['archive.7z', 'archive.rar', 'archive.tar', 'archive.tar.gz', 'single.txt.gz', 'single.txt.bz2', 'single.txt.xz', 'single.txt.zst']:
            with self.subTest(name=name):
                index, _ = self.run_file(name, 'archive-index')
                self.assertNotIn('error', index, index)
                entries = index['json']['entries']; self.assertGreater(len(entries), 0)
                selected = 'single.txt' if name.startswith('single.txt.') else 'notes.md'
                output, data = self.run_file(name, 'archive-extract', entry=selected, remaining=1024)
                self.assertNotIn('error', output, output)
                self.assertEqual(data, b'# Archive preview\n\nSynthetic archive text.\n')
        report, _ = self.run_file('sample-rar5.rar', 'archive-index')
        self.assertNotIn('error', report, report)
        self.assertTrue(report['json']['entries'])

    def test_archive_paths_links_and_remaining_budget(self):
        for name in ['unsafe.tar', 'symlink.tar']:
            report, _ = self.run_file(name, 'archive-index')
            self.assertIn(report.get('error'), ['LIMIT', 'UNSUPPORTED'])
        report, _ = self.run_file('archive.7z', 'archive-extract', entry='notes.md', remaining=1)
        self.assertEqual(report.get('error'), 'LIMIT')

    def test_native_decoder_process_cannot_open_files_network_or_processes(self):
        program = '''import os, socket
from archive_sandbox import restrict_archive_process
restrict_archive_process()
for action in (lambda: open('/etc/passwd','rb'), lambda: socket.socket(), lambda: os.fork()):
    try: action()
    except PermissionError: pass
    else: raise RuntimeError('sandbox allowed a forbidden syscall')
print('isolated')
'''
        result = subprocess.run([sys.executable, '-B', '-c', program], cwd=HERE, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertEqual(result.stdout.strip(), b'isolated')

class CertificateNetwork(unittest.TestCase):
    def test_nonpublic_and_transition_addresses_are_denied(self):
        for ip in ['127.0.0.1','10.0.0.1','169.254.169.254','100.64.0.1','0.0.0.0','192.168.1.1','::1','fe80::1','fe90::1','ff02::1','::ffff:127.0.0.1','64:ff9b::7f00:1','64:ff9b:1::1','2002:7f00:1::1','2001::1']:
            with self.subTest(ip=ip): self.assertFalse(public_ip(ip))
        self.assertTrue(public_ip('8.8.8.8'))
        self.assertTrue(public_ip('2606:4700:4700::1111'))

    def test_mixed_dns_response_is_refused_before_any_socket(self):
        async def run():
            loop = asyncio.get_running_loop()
            async def answer(*_args, **_kwargs):
                return [(socket.AF_INET,socket.SOCK_STREAM,6,'',('8.8.8.8',80)), (socket.AF_INET,socket.SOCK_STREAM,6,'',('127.0.0.1',80))]
            with patch.object(loop, 'getaddrinfo', answer):
                with self.assertRaises(OSError): await PublicResolver().resolve('attacker.example',80)
        asyncio.run(run())

if __name__ == '__main__': unittest.main()
