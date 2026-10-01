"""Bounded memory-only archive reader; never creates extracted files."""
import re
import libarchive
from libarchive.exception import ArchiveError
FILE_LIMIT = 50 * 1024 * 1024
TOTAL_LIMIT = 150 * 1024 * 1024


def safe_name(name):
    return (isinstance(name, str) and 0 < len(name) <= 1024
            and not re.search(r'[\x00-\x1f\x7f\\]', name)
            and not name.startswith('/') and not re.match(r'^[A-Za-z]:', name)
            and not any(part in ('.', '..') for part in name.split('/')))


def read_archive(data, options, raw=False):
    entries, names, selected = [], set(), None
    total = 0
    remaining = options.get('remaining', FILE_LIMIT)
    if not isinstance(remaining, (int, float)) or not 0 <= remaining <= TOTAL_LIMIT:
        raise ValueError('LIMIT')
    requested = options.get('entry')
    with libarchive.memory_reader(data, format_name='raw' if raw else 'all', filter_name='all') as archive:
        for entry in archive:
            name = entry.pathname
            if raw:
                name = re.sub(r'\.(gz|gzip|bz2|xz|zst|zstd)$', '', options.get('filename', 'data.gz'), flags=re.I) or 'data'
            if len(entries) >= 500 or not safe_name(name) or name in names:
                raise ValueError('LIMIT')
            if entry.issym or entry.islnk or not (entry.isfile or entry.isdir):
                raise ValueError('UNSUPPORTED')
            names.add(name)
            if entry.size is not None and (entry.size < 0 or entry.size > FILE_LIMIT):
                raise ValueError('LIMIT')
            chunks, size = [], 0
            for block in entry.get_blocks():
                size += len(block)
                total += len(block)
                if size > FILE_LIMIT or total > TOTAL_LIMIT:
                    raise ValueError('LIMIT')
                if requested == name:
                    if size > remaining:
                        raise ValueError('LIMIT')
                    chunks.append(block)
            if entry.size is not None and entry.size != size and not entry.isdir:
                raise ValueError('CORRUPT')
            entries.append({'name': name, 'size': size, 'directory': entry.isdir, 'encrypted': False})
            if requested == name and not entry.isdir:
                selected = b''.join(chunks)
    if not entries:
        raise ValueError('CORRUPT')
    if options['action'] == 'archive-extract':
        if selected is None:
            raise ValueError('INVALID_INPUT')
        return {'filename': requested, 'bytes': selected}
    return {'json': {'entries': entries, 'total': total}}


def process_archive(data, options):
    try:
        return read_archive(data, options)
    except ArchiveError as error:
        compressed = data.startswith((b'\x1f\x8b', b'BZh', b'\xfd7zXZ\x00', b'\x28\xb5\x2f\xfd'))
        if compressed and 'Unrecognized archive format' in str(error):
            return read_archive(data, options, raw=True)
        if 'encrypt' in str(error).lower() or 'passphrase' in str(error).lower():
            raise ValueError('ENCRYPTED_ZIP') from None
        raise ValueError('CORRUPT') from None
