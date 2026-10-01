# Attachment preview fixtures

All preview content is synthetic. Regenerate the image/PDF/document/text/media fixtures with
`scripts/generate-attachment-fixtures.py` in an isolated Python environment with ReportLab,
Pillow, pypdf and python-docx, plus FFmpeg. Spreadsheet and encrypted ZIP fixtures come from
`node frontend/scripts/generate-attachment-fixtures.mjs`. CI uses the committed files and
needs neither Python packages nor FFmpeg.

`hundred-pages.pdf` has 100 pages, an outline pointing to page 87, selectable text, and unique
`invoice-NNN` search tokens. `password.pdf` uses the test-only password `preview-password`.
`empty-signature.pdf` contains an **unsigned, empty** signature field, not a valid signature.

The encrypted Office fixtures and `plain.xls` are from msoffcrypto-tool at the immutable
commit recorded in `provenance.json`, under the included MIT license. Its upstream tests
specify `Password1234_` for Agile, Standard and RC4 CryptoAPI fixtures, and
`123456789012345` for the XOR XLS fixture. These are public test passwords, not credentials.
`encrypted.zip` uses `archive-password`; encrypted ZIP preview is deliberately unsupported.

Adversarial SVG/HTML/DOCX examples use only `attachment-tracker.example.test` and sentinel
JavaScript. They must neither make network requests nor execute. Archive fixtures exercise
path traversal, symlinks, excessive entry counts, and a compressed entry beyond the 50 MiB
limit. Do not extract those archives to the filesystem.

The `*.eml.json`, `*.ics.json` and `*.vcf.json` files are expected parser output for the
mocked browser matrix; the live browser gate calls the production parser instead. The
`unlocked-example.*` files are decrypted forms of the licensed synthetic Office fixtures.

`sample-rar5.rar` is the stored RAR5 fixture from libarchive (`libarchive/test/test_read_format_rar5_stored.rar.uu`, Git blob `afd565ff97d461dad905185f83860ecb2f1bccf8`). Its upstream license is included in LICENSE-libarchive.txt. No archive content is executed.

Follow-up fixtures: archive.7z, archive.rar (stored RAR4), archive.tar, archive.tar.gz, single.txt.gz and signature-sample.pdf are synthetic outputs of backend/preview/generate_fixtures.py. The PDF uses a test-only CA, not an independently trusted identity. Its private keys were never saved. paged-background.docx extends document.docx with an explicit page break, a second-page marker and a DCEBFA page background. Browser metadata fixtures exercise UI, while Python tests generate fresh PKI and verify actual cryptographic/revocation results.
