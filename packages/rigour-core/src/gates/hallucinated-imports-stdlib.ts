/**
 * Standard library detection helpers for hallucinated-imports gate.
 * Each function returns true if the given import path is part of that language's stdlib.
 */

export function isNodeBuiltin(name: string): boolean {
    // Fast path: node: protocol prefix
    if (name.startsWith('node:')) return true;

    const builtins = new Set([
        'assert', 'assert/strict', 'async_hooks', 'buffer', 'child_process',
        'cluster', 'console', 'constants', 'crypto', 'dgram', 'diagnostics_channel',
        'dns', 'dns/promises', 'domain', 'events', 'fs', 'fs/promises',
        'http', 'http2', 'https', 'inspector', 'inspector/promises', 'module',
        'net', 'os', 'path', 'path/posix', 'path/win32', 'perf_hooks',
        'process', 'punycode', 'querystring', 'readline', 'readline/promises',
        'repl', 'stream', 'stream/consumers', 'stream/promises', 'stream/web',
        'string_decoder', 'sys', 'test', 'timers', 'timers/promises',
        'tls', 'trace_events', 'tty', 'url', 'util', 'util/types',
        'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
    ]);
    return builtins.has(name);
}

export function isPythonStdlib(modulePath: string): boolean {
    const topLevel = modulePath.split('.')[0];
    const stdlibs = new Set([
        'abc', 'aifc', 'argparse', 'array', 'ast', 'asyncio', 'atexit',
        'base64', 'bdb', 'binascii', 'binhex', 'bisect', 'builtins',
        'calendar', 'cgi', 'cgitb', 'chunk', 'cmath', 'cmd', 'code',
        'codecs', 'codeop', 'collections', 'colorsys', 'compileall',
        'concurrent', 'configparser', 'contextlib', 'contextvars', 'copy',
        'copyreg', 'cProfile', 'csv', 'ctypes', 'curses', 'dataclasses',
        'datetime', 'dbm', 'decimal', 'difflib', 'dis', 'distutils',
        'doctest', 'email', 'encodings', 'enum', 'errno', 'faulthandler',
        'fcntl', 'filecmp', 'fileinput', 'fnmatch', 'fractions', 'ftplib',
        'functools', 'gc', 'getopt', 'getpass', 'gettext', 'glob', 'grp',
        'gzip', 'hashlib', 'heapq', 'hmac', 'html', 'http', 'idlelib',
        'imaplib', 'imghdr', 'importlib', 'inspect', 'io', 'ipaddress',
        'itertools', 'json', 'keyword', 'lib2to3', 'linecache', 'locale',
        'logging', 'lzma', 'mailbox', 'mailcap', 'marshal', 'math',
        'mimetypes', 'mmap', 'modulefinder', 'multiprocessing', 'netrc',
        'nis', 'nntplib', 'numbers', 'operator', 'optparse', 'os',
        'ossaudiodev', 'parser', 'pathlib', 'pdb', 'pickle', 'pickletools',
        'pipes', 'pkgutil', 'platform', 'plistlib', 'poplib', 'posix',
        'posixpath', 'pprint', 'profile', 'pstats', 'pty', 'pwd', 'py_compile',
        'pyclbr', 'pydoc', 'queue', 'quopri', 'random', 're', 'readline',
        'reprlib', 'resource', 'rlcompleter', 'runpy', 'sched', 'secrets',
        'select', 'selectors', 'shelve', 'shlex', 'shutil', 'signal',
        'site', 'smtpd', 'smtplib', 'sndhdr', 'socket', 'socketserver',
        'spwd', 'sqlite3', 'sre_compile', 'sre_constants', 'sre_parse',
        'ssl', 'stat', 'statistics', 'string', 'stringprep', 'struct',
        'subprocess', 'sunau', 'symtable', 'sys', 'sysconfig', 'syslog',
        'tabnanny', 'tarfile', 'telnetlib', 'tempfile', 'termios', 'test',
        'textwrap', 'threading', 'time', 'timeit', 'tkinter', 'token',
        'tokenize', 'tomllib', 'trace', 'traceback', 'tracemalloc', 'tty',
        'turtle', 'turtledemo', 'types', 'typing', 'unicodedata', 'unittest',
        'urllib', 'uu', 'uuid', 'venv', 'warnings', 'wave', 'weakref',
        'webbrowser', 'winreg', 'winsound', 'wsgiref', 'xdrlib', 'xml',
        'xmlrpc', 'zipapp', 'zipfile', 'zipimport', 'zlib',
        '_thread', '__future__', '__main__',
    ]);
    return stdlibs.has(topLevel);
}

export function isGoStdlib(importPath: string): boolean {
    // Fast check: single-segment packages are always stdlib if no dots
    if (!importPath.includes('/') && !importPath.includes('.')) return true;

    // Check the full path against known stdlib packages with sub-paths
    const topLevel = importPath.split('/')[0];

    // All Go stdlib top-level packages (including those with sub-packages)
    const stdlibTopLevel = new Set([
        // Single-word packages
        'archive', 'bufio', 'builtin', 'bytes', 'cmp', 'compress',
        'container', 'context', 'crypto', 'database', 'debug',
        'embed', 'encoding', 'errors', 'expvar', 'flag', 'fmt',
        'go', 'hash', 'html', 'image', 'index', 'io', 'iter',
        'log', 'maps', 'math', 'mime', 'net', 'os', 'path',
        'plugin', 'reflect', 'regexp', 'runtime', 'slices', 'sort',
        'strconv', 'strings', 'structs', 'sync', 'syscall',
        'testing', 'text', 'time', 'unicode', 'unique', 'unsafe',
        // Internal packages (used by stdlib, sometimes by tools)
        'internal', 'vendor',
    ]);

    if (stdlibTopLevel.has(topLevel)) return true;

    // Explicit full-path list for maximum safety — covers all Go 1.22 stdlib paths
    // This catches any edge case the top-level check might miss
    const knownStdlibPaths = new Set([
        // archive/*
        'archive/tar', 'archive/zip',
        // compress/*
        'compress/bzip2', 'compress/flate', 'compress/gzip', 'compress/lzw', 'compress/zlib',
        // container/*
        'container/heap', 'container/list', 'container/ring',
        // crypto/*
        'crypto/aes', 'crypto/cipher', 'crypto/des', 'crypto/dsa',
        'crypto/ecdh', 'crypto/ecdsa', 'crypto/ed25519', 'crypto/elliptic',
        'crypto/hmac', 'crypto/md5', 'crypto/rand', 'crypto/rc4',
        'crypto/rsa', 'crypto/sha1', 'crypto/sha256', 'crypto/sha512',
        'crypto/subtle', 'crypto/tls', 'crypto/x509', 'crypto/x509/pkix',
        // database/*
        'database/sql', 'database/sql/driver',
        // debug/*
        'debug/buildinfo', 'debug/dwarf', 'debug/elf', 'debug/gosym',
        'debug/macho', 'debug/pe', 'debug/plan9obj',
        // encoding/*
        'encoding/ascii85', 'encoding/asn1', 'encoding/base32', 'encoding/base64',
        'encoding/binary', 'encoding/csv', 'encoding/gob', 'encoding/hex',
        'encoding/json', 'encoding/pem', 'encoding/xml',
        // go/*
        'go/ast', 'go/build', 'go/build/constraint', 'go/constant',
        'go/doc', 'go/doc/comment', 'go/format', 'go/importer',
        'go/parser', 'go/printer', 'go/scanner', 'go/token', 'go/types', 'go/version',
        // hash/*
        'hash/adler32', 'hash/crc32', 'hash/crc64', 'hash/fnv', 'hash/maphash',
        // html/*
        'html/template',
        // image/*
        'image/color', 'image/color/palette', 'image/draw',
        'image/gif', 'image/jpeg', 'image/png',
        // index/*
        'index/suffixarray',
        // io/*
        'io/fs', 'io/ioutil',
        // log/*
        'log/slog', 'log/syslog',
        // math/*
        'math/big', 'math/bits', 'math/cmplx', 'math/rand', 'math/rand/v2',
        // mime/*
        'mime/multipart', 'mime/quotedprintable',
        // net/*
        'net/http', 'net/http/cgi', 'net/http/cookiejar', 'net/http/fcgi',
        'net/http/httptest', 'net/http/httptrace', 'net/http/httputil',
        'net/http/pprof', 'net/mail', 'net/netip', 'net/rpc',
        'net/rpc/jsonrpc', 'net/smtp', 'net/textproto', 'net/url',
        // os/*
        'os/exec', 'os/signal', 'os/user',
        // path/*
        'path/filepath',
        // regexp/*
        'regexp/syntax',
        // runtime/*
        'runtime/cgo', 'runtime/coverage', 'runtime/debug', 'runtime/metrics',
        'runtime/pprof', 'runtime/race', 'runtime/trace',
        // sync/*
        'sync/atomic',
        // testing/*
        'testing/fstest', 'testing/iotest', 'testing/quick', 'testing/slogtest',
        // text/*
        'text/scanner', 'text/tabwriter', 'text/template', 'text/template/parse',
        // unicode/*
        'unicode/utf16', 'unicode/utf8',
    ]);

    return knownStdlibPaths.has(importPath);
}

export function isRubyStdlib(name: string): boolean {
    const topLevel = name.split('/')[0];
    const stdlibs = new Set([
        // Core libs (always available)
        'abbrev', 'base64', 'benchmark', 'bigdecimal', 'cgi', 'csv',
        'date', 'delegate', 'did_you_mean', 'digest', 'drb', 'english',
        'erb', 'error_highlight', 'etc', 'fcntl', 'fiddle', 'fileutils',
        'find', 'forwardable', 'getoptlong', 'io', 'ipaddr', 'irb',
        'json', 'logger', 'matrix', 'minitest', 'monitor', 'mutex_m',
        'net', 'nkf', 'objspace', 'observer', 'open3', 'open-uri',
        'openssl', 'optparse', 'ostruct', 'pathname', 'pp', 'prettyprint',
        'prime', 'pstore', 'psych', 'racc', 'rake', 'rdoc', 'readline',
        'reline', 'resolv', 'resolv-replace', 'rinda', 'ruby2_keywords',
        'rubygems', 'securerandom', 'set', 'shellwords', 'singleton',
        'socket', 'stringio', 'strscan', 'syntax_suggest', 'syslog',
        'tempfile', 'time', 'timeout', 'tmpdir', 'tsort', 'un',
        'unicode_normalize', 'uri', 'weakref', 'yaml', 'zlib',
        // Default gems (ship with Ruby, can be overridden)
        'bundler', 'debug', 'net-ftp', 'net-http', 'net-imap',
        'net-pop', 'net-protocol', 'net-smtp', 'power_assert',
        'test-unit', 'rexml', 'rss', 'typeprof',
        // Common C extensions
        'stringio', 'io/console', 'io/nonblock', 'io/wait',
        'rbconfig', 'mkmf', 'thread',
        // Rails-adjacent but actually stdlib
        'webrick', 'cmath', 'complex', 'rational',
        'coverage', 'ripper', 'win32ole', 'win32api',
    ]);
    return stdlibs.has(topLevel);
}

export function isDotNetFramework(namespace: string): boolean {
    const topLevel = namespace.split('.')[0];
    const frameworkPrefixes = new Set([
        // BCL / .NET Runtime
        'System', 'Microsoft', 'Windows',
        // Common ecosystem (NuGet defaults everyone uses)
        'Newtonsoft', 'NUnit', 'Xunit', 'Moq', 'AutoMapper',
        'FluentAssertions', 'FluentValidation', 'Serilog', 'NLog',
        'Dapper', 'MediatR', 'Polly', 'Swashbuckle', 'Hangfire',
        'StackExchange', 'Npgsql', 'MongoDB', 'MySql', 'Oracle',
        'Amazon', 'Google', 'Azure', 'Grpc',
        'Bogus', 'Humanizer', 'CsvHelper', 'MailKit', 'MimeKit',
        'RestSharp', 'Refit', 'AutoFixture', 'Shouldly',
        'IdentityModel', 'IdentityServer4',
    ]);
    return frameworkPrefixes.has(topLevel);
}

export function isRustStdCrate(name: string): boolean {
    const stdCrates = new Set([
        'std', 'core', 'alloc', 'proc_macro', 'test',
        // Common proc-macro / compiler crates
        'proc_macro2', 'syn', 'quote',
    ]);
    return stdCrates.has(name);
}

export function isJavaStdlib(importPath: string): boolean {
    const prefixes = [
        'java.', 'javax.', 'jakarta.',
        'sun.', 'com.sun.', 'jdk.',
        // Android SDK
        'android.', 'androidx.',
        // Common ecosystem (so ubiquitous they're basically stdlib)
        'org.junit.', 'org.slf4j.', 'org.apache.logging.',
    ];
    return prefixes.some(p => importPath.startsWith(p));
}

export function isKotlinStdlib(importPath: string): boolean {
    const prefixes = [
        'kotlin.', 'kotlinx.',
        // Java interop (Kotlin can use Java stdlib directly)
        'java.', 'javax.', 'jakarta.',
    ];
    return prefixes.some(p => importPath.startsWith(p));
}
