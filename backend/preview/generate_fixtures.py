"""Synthetic test PKI and documents. Private keys live only in this process."""
import io
import json
import gzip
import bz2
import lzma
import tarfile
import struct
import zlib
from datetime import datetime, timedelta, timezone
from pathlib import Path
from cryptography import x509
from cryptography.x509.oid import NameOID, ExtendedKeyUsageOID
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from asn1crypto import keys as asn_keys, x509 as asn_x509
from pyhanko.sign import signers, fields
from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter
from pyhanko_certvalidator.registry import SimpleCertificateStore
import libarchive


def generate(destination=None):
    fixtures = Path(__file__).resolve().parents[1] / 'fixtures' / 'attachments'
    out = Path(destination) if destination else fixtures / 'generated'
    out.mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc)
    root_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    root_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'Inboxora fixture root')])
    root = (x509.CertificateBuilder().subject_name(root_name).issuer_name(root_name).public_key(root_key.public_key())
            .serial_number(x509.random_serial_number()).not_valid_before(now-timedelta(days=30)).not_valid_after(now+timedelta(days=3650))
            .add_extension(x509.BasicConstraints(ca=True, path_length=1), True)
            .add_extension(x509.KeyUsage(False, False, False, False, False, True, True, False, False), True)
            .add_extension(x509.SubjectKeyIdentifier.from_public_key(root_key.public_key()), False)
            .sign(root_key, hashes.SHA256()))
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'Inboxora synthetic signer'), x509.NameAttribute(NameOID.GIVEN_NAME, 'Preview'),
                         x509.NameAttribute(NameOID.SURNAME, 'Fixture'), x509.NameAttribute(NameOID.ORGANIZATION_NAME, 'Inboxora tests'),
                         x509.NameAttribute(NameOID.COUNTRY_NAME, 'PL'), x509.NameAttribute(NameOID.EMAIL_ADDRESS, 'fixture@example.test')])
    cert = (x509.CertificateBuilder().subject_name(subject).issuer_name(root.subject).public_key(key.public_key())
            .serial_number(x509.random_serial_number()).not_valid_before(now-timedelta(days=1)).not_valid_after(now+timedelta(days=365))
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), True)
            .add_extension(x509.KeyUsage(True, True, False, False, False, False, False, False, False), True)
            .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(root_key.public_key()), False)
            .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), False).sign(root_key, hashes.SHA256()))
    (out/'root.pem').write_bytes(root.public_bytes(serialization.Encoding.PEM))
    for name, revoked in [('good', False), ('revoked', True)]:
        folder = out/name; folder.mkdir(exist_ok=True)
        builder = (x509.CertificateRevocationListBuilder().issuer_name(root.subject).last_update(now-timedelta(minutes=5)).next_update(now+timedelta(days=7))
                   .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(root_key.public_key()), False))
        if revoked:
            builder = builder.add_revoked_certificate(x509.RevokedCertificateBuilder().serial_number(cert.serial_number).revocation_date(now-timedelta(minutes=3)).build())
        (folder/'issuer.crl').write_bytes(builder.sign(root_key, hashes.SHA256()).public_bytes(serialization.Encoding.DER))
    registry = SimpleCertificateStore(); registry.register(asn_x509.Certificate.load(root.public_bytes(serialization.Encoding.DER)))
    signer = signers.SimpleSigner(signing_cert=asn_x509.Certificate.load(cert.public_bytes(serialization.Encoding.DER)),
        signing_key=asn_keys.PrivateKeyInfo.load(key.private_bytes(serialization.Encoding.DER, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())), cert_registry=registry)
    def signed(source, name, identity=signer):
        output = io.BytesIO()
        signers.PdfSigner(signers.PdfSignatureMetadata(field_name=name, reason='Fixture approval', location='Warsaw'), signer=identity,
            new_field_spec=fields.SigFieldSpec(sig_field_name=name, on_page=0, box=(40,40,240,80))).sign_pdf(IncrementalPdfFileWriter(io.BytesIO(source)), output=output)
        return output.getvalue()
    data = signed((fixtures/'hundred-pages.pdf').read_bytes(), 'Approval')
    (out/'signed.pdf').write_bytes(data)
    for variant in ('tls-only', 'expired'):
        builder = (x509.CertificateBuilder().subject_name(subject).issuer_name(root.subject).public_key(key.public_key())
            .serial_number(x509.random_serial_number()).not_valid_before(now-timedelta(days=30))
            .not_valid_after(now-timedelta(days=1) if variant == 'expired' else now+timedelta(days=365))
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), True)
            .add_extension(x509.KeyUsage(True, True, False, False, False, False, False, False, False), True)
            .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(root_key.public_key()), False))
        if variant == 'tls-only':
            builder = builder.add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), False)
        alternate = builder.sign(root_key, hashes.SHA256())
        identity = signers.SimpleSigner(signing_cert=asn_x509.Certificate.load(alternate.public_bytes(serialization.Encoding.DER)),
            signing_key=signer.signing_key, cert_registry=registry)
        (out/f'{variant}.pdf').write_bytes(signed((fixtures/'hundred-pages.pdf').read_bytes(), 'Approval', identity))

    (out/'signed-twice.pdf').write_bytes(signed(data, 'SecondApproval'))
    changed = bytearray(data); version = changed.find(b'%PDF-'); assert version >= 0
    changed[version+7] = ord('4') if changed[version+7] != ord('4') else ord('5')
    (out/'tampered.pdf').write_bytes(changed)
    content = b'# Archive preview\n\nSynthetic archive text.\n'
    for suffix, format_name in [('7z', '7zip'), ('tar', 'pax_restricted')]:
        with libarchive.file_writer(str(out/f'archive.{suffix}'), format_name) as archive:
            archive.add_file_from_memory('notes.md', len(content), content)
            image = (fixtures/'image.png').read_bytes(); archive.add_file_from_memory('image.png', len(image), image)
    (out/'archive.tar.gz').write_bytes(gzip.compress((out/'archive.tar').read_bytes(), mtime=0))
    (out/'single.txt.gz').write_bytes(gzip.compress(content, mtime=0))
    (out/'single.txt.bz2').write_bytes(bz2.compress(content))
    (out/'single.txt.xz').write_bytes(lzma.compress(content))
    with libarchive.file_writer(str(out/'single.txt.zst'), 'raw', filter_name='zstd') as archive:
        archive.add_file_from_memory('single.txt', len(content), content)

    def rar_header(body):
        return struct.pack('<H', zlib.crc32(body) & 65535) + body
    name = b'notes.md'
    main = rar_header(struct.pack('<BHHHI', 115, 0, 13, 0, 0))
    entry = rar_header(struct.pack('<BHHIIBIIBBHI', 116, 32768, 32+len(name), len(content), len(content), 3, zlib.crc32(content), 0, 20, 48, len(name), 33188) + name)
    end = rar_header(struct.pack('<BHH', 123, 0, 7))
    (out/'archive.rar').write_bytes(bytes([82,97,114,33,26,7,0]) + main + entry + content + end)

    with tarfile.open(out/'unsafe.tar', 'w') as archive:
        entry = tarfile.TarInfo('../outside.txt'); entry.size=1; archive.addfile(entry, io.BytesIO(b'x'))
    with tarfile.open(out/'symlink.tar', 'w') as archive:
        entry = tarfile.TarInfo('link'); entry.type=tarfile.SYMTYPE; entry.linkname='/etc/passwd'; archive.addfile(entry)
    return out

if __name__ == '__main__':
    import sys
    print(generate(sys.argv[1] if len(sys.argv)>1 else None))
