"""Drop filesystem, network and process-creation syscalls before native decoding.

All libraries and input bytes must be loaded first. Failure to install this filter
is a refusal to decode, never permission to run without it. Linux/amd64 and arm64
use libseccomp's architecture-specific syscall resolver.
"""
import ctypes
import errno
import importlib


def restrict_archive_process():
    for encoding in ('utf_8', 'utf_16_le', 'utf_16_be', 'latin_1', 'cp437', 'cp850', 'cp1250', 'cp1251', 'cp1252'):
        importlib.import_module('encodings.' + encoding)
    libc = ctypes.CDLL(None)
    # glibc may lazily load iconv modules; musl implements these in libc.
    if hasattr(libc, 'iconv_open'):
        libc.iconv_open.argtypes = [ctypes.c_char_p, ctypes.c_char_p]
        libc.iconv_open.restype = ctypes.c_void_p
        for encoding in (b'CP437', b'CP850', b'WINDOWS-1250', b'WINDOWS-1251', b'WINDOWS-1252', b'UTF-16LE', b'UTF-16BE', b'SHIFT_JIS', b'GB18030', b'BIG5'):
            libc.iconv_open(b'UTF-8', encoding)
    try:
        library = ctypes.CDLL('libseccomp.so.2', use_errno=True)
    except OSError:
        raise ValueError('UNSUPPORTED') from None
    library.seccomp_init.argtypes = [ctypes.c_uint32]
    library.seccomp_init.restype = ctypes.c_void_p
    library.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    library.seccomp_syscall_resolve_name.restype = ctypes.c_int
    library.seccomp_rule_add.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint]
    library.seccomp_rule_add.restype = ctypes.c_int
    library.seccomp_load.argtypes = [ctypes.c_void_p]
    library.seccomp_load.restype = ctypes.c_int
    library.seccomp_release.argtypes = [ctypes.c_void_p]
    context = library.seccomp_init(0x00050000 | errno.EPERM)
    if not context:
        raise ValueError('UNSUPPORTED')
    # Only memory management, this process's existing pipes and basic runtime
    # operations are allowed. New Linux syscalls are denied automatically.
    allowed = """read readv write writev close fstat fstat64 lseek fcntl fcntl64 ioctl
        mmap mmap2 munmap mremap mprotect brk madvise
        rt_sigaction rt_sigprocmask rt_sigreturn sigaltstack
        futex futex_time64 sched_yield getpid gettid getppid getrandom
        clock_gettime clock_gettime64 gettimeofday time nanosleep clock_nanosleep
        clock_nanosleep_time64 getrusage restart_syscall exit exit_group""".split()
    try:
        for name in allowed:
            syscall = library.seccomp_syscall_resolve_name(name.encode('ascii'))
            if syscall >= 0 and library.seccomp_rule_add(context, 0x7fff0000, syscall, 0) != 0:
                raise ValueError('UNSUPPORTED')
        if library.seccomp_load(context) != 0:
            raise ValueError('UNSUPPORTED')
    finally:
        library.seccomp_release(context)
