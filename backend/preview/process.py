"""Disposable worker protocol: one bounded JSON line, then original bytes, all in pipes."""
import asyncio
import json
import logging
import resource
import sys

resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
resource.setrlimit(resource.RLIMIT_FSIZE, (0, 0))
resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024, 512 * 1024 * 1024))
resource.setrlimit(resource.RLIMIT_CPU, (20, 20))
resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
logging.disable(logging.CRITICAL)
MAX = 50 * 1024 * 1024
try:
    header = sys.stdin.buffer.readline(8193)
    if len(header) > 8192 or not header.endswith(b'\n'):
        raise ValueError('INVALID_INPUT')
    options = json.loads(header)
    data = sys.stdin.buffer.read(MAX + 1)
    if not data or len(data) > MAX:
        raise ValueError('LIMIT')
    if options.get('action') == 'signatures':
        from signatures import inspect_signatures
        result = asyncio.run(asyncio.wait_for(inspect_signatures(data), timeout=25))
    elif options.get('action') in ('archive-index', 'archive-extract'):
        from archive_reader import process_archive
        from archive_sandbox import restrict_archive_process
        restrict_archive_process()
        result = process_archive(data, options)
    else:
        raise ValueError('INVALID_INPUT')
    payload = result.pop('bytes', b'')
    encoded = json.dumps(result | {'byteLength': len(payload)}, separators=(',', ':')).encode()
    if len(encoded) > 4 * 1024 * 1024 or len(payload) > MAX:
        raise ValueError('LIMIT')
    sys.stdout.buffer.write(encoded + b'\n')
    sys.stdout.buffer.write(payload)
except (MemoryError, RecursionError, TimeoutError):
    sys.stdout.write('{"error":"LIMIT"}\n')
except Exception as error:
    code = str(error) if isinstance(error, ValueError) and str(error) in ('LIMIT', 'CORRUPT', 'INVALID_INPUT', 'UNSUPPORTED', 'ENCRYPTED_ZIP') else 'CORRUPT'
    sys.stdout.write(json.dumps({'error': code}) + '\n')
