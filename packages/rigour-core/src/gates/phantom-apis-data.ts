/**
 * Data constants for phantom-apis gate.
 * Language rule sets and stdlib method maps extracted to keep phantom-apis.ts under 500 lines.
 */


export interface PhantomRule {
    pattern: RegExp;
    module: string;
    phantom: string;
    suggestion: string;
}

/**
 * Go commonly hallucinated APIs — AI mixes up Python/JS idioms with Go.
 */
export const GO_PHANTOM_RULES: PhantomRule[] = [
    { pattern: /\bstrings\.includes\s*\(/, module: 'strings', phantom: 'includes', suggestion: "Use strings.Contains()" },
    { pattern: /\bstrings\.lower\s*\(/, module: 'strings', phantom: 'lower', suggestion: "Use strings.ToLower()" },
    { pattern: /\bstrings\.upper\s*\(/, module: 'strings', phantom: 'upper', suggestion: "Use strings.ToUpper()" },
    { pattern: /\bstrings\.strip\s*\(/, module: 'strings', phantom: 'strip', suggestion: "Use strings.TrimSpace()" },
    { pattern: /\bstrings\.find\s*\(/, module: 'strings', phantom: 'find', suggestion: "Use strings.Index()" },
    { pattern: /\bstrings\.startswith\s*\(/, module: 'strings', phantom: 'startswith', suggestion: "Use strings.HasPrefix()" },
    { pattern: /\bstrings\.endswith\s*\(/, module: 'strings', phantom: 'endswith', suggestion: "Use strings.HasSuffix()" },
    // NOTE: os.ReadFile IS real (Go 1.16+). os.WriteFile IS real (Go 1.16+). Do NOT add them here.
    { pattern: /\bos\.Exists\s*\(/, module: 'os', phantom: 'Exists', suggestion: "Use os.Stat() and check os.IsNotExist(err)" },
    { pattern: /\bos\.isdir\s*\(/, module: 'os', phantom: 'isdir', suggestion: "Use os.Stat() then .IsDir()" },
    { pattern: /\bos\.listdir\s*\(/, module: 'os', phantom: 'listdir', suggestion: "Use os.ReadDir()" },
    { pattern: /\bfmt\.Format\s*\(/, module: 'fmt', phantom: 'Format', suggestion: "Use fmt.Sprintf()" },
    // NOTE: fmt.Print, fmt.Println, fmt.Printf, fmt.Sprintf, fmt.Fprintf, fmt.Errorf are ALL real — do NOT add them here.
    { pattern: /\bhttp\.Get\s*\([^)]*\)\s*\.\s*Body/, module: 'http', phantom: 'Get().Body', suggestion: "http.Get() returns (*Response, error) — must check error first" },
    { pattern: /\bjson\.parse\s*\(/, module: 'json', phantom: 'parse', suggestion: "Use json.Unmarshal()" },
    { pattern: /\bjson\.stringify\s*\(/, module: 'json', phantom: 'stringify', suggestion: "Use json.Marshal()" },
    { pattern: /\bfilepath\.Combine\s*\(/, module: 'filepath', phantom: 'Combine', suggestion: "Use filepath.Join()" },
    // NOTE: math.Max() IS real (float64 only). If you need int support, that's a type mismatch, not a phantom API.
    { pattern: /\bsort\.Sort\s*\(\s*\[\]/, module: 'sort', phantom: 'Sort([]T)', suggestion: "sort.Sort() requires sort.Interface — use slices.Sort() (Go 1.21+) or sort.Slice()" },
];

/**
 * C# commonly hallucinated APIs — AI mixes up Java/Python idioms with .NET.
 */
export const CSHARP_PHANTOM_RULES: PhantomRule[] = [
    { pattern: /\.length\b(?!\s*\()/, module: 'String', phantom: '.length', suggestion: "Use .Length (capital L) in C#" },
    { pattern: /\.equals\s*\(/, module: 'Object', phantom: '.equals()', suggestion: "Use .Equals() (capital E) in C#" },
    { pattern: /\.toString\s*\(/, module: 'Object', phantom: '.toString()', suggestion: "Use .ToString() (capital T) in C#" },
    { pattern: /\.hashCode\s*\(/, module: 'Object', phantom: '.hashCode()', suggestion: "Use .GetHashCode() in C#" },
    { pattern: /\.getClass\s*\(/, module: 'Object', phantom: '.getClass()', suggestion: "Use .GetType() in C#" },
    { pattern: /\.isEmpty\s*\(/, module: 'String', phantom: '.isEmpty()', suggestion: "Use string.IsNullOrEmpty() or .Length == 0 in C#" },
    { pattern: /\.charAt\s*\(/, module: 'String', phantom: '.charAt()', suggestion: "Use string[index] indexer in C#" },
    { pattern: /\.substring\s*\(/, module: 'String', phantom: '.substring()', suggestion: "Use .Substring() (capital S) in C#" },
    { pattern: /\.indexOf\s*\(/, module: 'String', phantom: '.indexOf()', suggestion: "Use .IndexOf() (capital I) in C#" },
    { pattern: /List<[^>]+>\s+\w+\s*=\s*new\s+ArrayList/, module: 'Collections', phantom: 'ArrayList', suggestion: "Use new List<T>() in C# — ArrayList is Java" },
    { pattern: /HashMap</, module: 'Collections', phantom: 'HashMap', suggestion: "Use Dictionary<TKey, TValue> in C#" },
    { pattern: /System\.out\.println/, module: 'System', phantom: 'System.out.println', suggestion: "Use Console.WriteLine() in C#" },
    { pattern: /\.stream\s*\(\)\s*\./, module: 'Collections', phantom: '.stream()', suggestion: "Use LINQ (.Select, .Where, etc.) in C# — .stream() is Java" },
    { pattern: /\.forEach\s*\(\s*\w+\s*->/, module: 'Collections', phantom: '.forEach(x ->)', suggestion: "Use .ForEach(x =>) or foreach loop in C#" },
    { pattern: /File\.readAllText\s*\(/, module: 'File', phantom: 'readAllText', suggestion: "Use File.ReadAllText() (capital R) in C#" },
    { pattern: /throws\s+\w+Exception/, module: 'method', phantom: 'throws', suggestion: "C# doesn't use checked exceptions — remove throws clause" },
];

/**
 * Java commonly hallucinated APIs — AI mixes up Python/JS/C# idioms with JDK.
 */
export const JAVA_PHANTOM_RULES: PhantomRule[] = [
    { pattern: /\.len\s*\(/, module: 'Object', phantom: '.len()', suggestion: "Use .length() for String, .size() for Collection, .length for arrays in Java" },
    { pattern: /\bprint\s*\(\s*['"]/, module: 'IO', phantom: 'print()', suggestion: "Use System.out.println() in Java" },
    // NOTE: .push() removed — Deque.push() and Stack.push() ARE valid Java. Cannot safely flag .push().
    // NOTE: .append() removed — StringBuilder.append() IS valid Java. The lookahead was inverted (checked content
    //   after open paren, not variable before). Cannot safely distinguish list.append() from sb.append() via regex.
    { pattern: /\.include(?:s)?\s*\(/, module: 'Collection', phantom: '.includes()', suggestion: "Use .contains() in Java" },
    { pattern: /\.slice\s*\(/, module: 'List', phantom: '.slice()', suggestion: "Use .subList() for List in Java" },
    { pattern: /\.map\s*\(\s*\w+\s*=>/, module: 'Collection', phantom: '.map(x =>)', suggestion: "Use .stream().map(x ->) in Java — arrow is -> not =>" },
    { pattern: /\.filter\s*\(\s*\w+\s*=>/, module: 'Collection', phantom: '.filter(x =>)', suggestion: "Use .stream().filter(x ->) in Java — arrow is -> not =>" },
    { pattern: /Console\.(?:Write|Read)/, module: 'IO', phantom: 'Console', suggestion: "Console is C# — use System.out.println() or Scanner in Java" },
    { pattern: /\bvar\s+\w+\s*:\s*\w+\s*=/, module: 'syntax', phantom: 'var x: Type =', suggestion: "Java var doesn't use type annotation: use 'var x =' or 'Type x ='" },
    // NOTE: .sorted() removed — stream().sorted() IS valid Java. Cannot distinguish from list.sorted().
    // NOTE: .reversed() removed — List.reversed() and stream().reversed() are valid in Java 21+.
    { pattern: /String\.format\s*\(\s*\$"/, module: 'String', phantom: 'String.format($"...")', suggestion: "String interpolation $\"\" is C# — use String.format(\"%s\", ...) in Java" },
    { pattern: /\bnew\s+Map\s*[<(]/, module: 'Collections', phantom: 'new Map()', suggestion: "Use new HashMap<>() in Java — Map is an interface" },
    { pattern: /\bnew\s+List\s*[<(]/, module: 'Collections', phantom: 'new List()', suggestion: "Use new ArrayList<>() in Java — List is an interface" },
];

/**
 * Node.js 22.x stdlib method signatures.
 * Only the most commonly hallucinated modules are covered.
 * Each set contains ALL public methods/properties accessible on the module.
 */
export const NODE_STDLIB_METHODS: Record<string, Set<string>> = {
    fs: new Set([
        // Sync methods
        'readFileSync', 'writeFileSync', 'appendFileSync', 'copyFileSync', 'renameSync',
        'unlinkSync', 'mkdirSync', 'rmdirSync', 'rmSync', 'readdirSync', 'statSync',
        'lstatSync', 'existsSync', 'accessSync', 'chmodSync', 'chownSync', 'closeSync',
        'fchmodSync', 'fchownSync', 'fdatasyncSync', 'fstatSync', 'fsyncSync',
        'ftruncateSync', 'futimesSync', 'linkSync', 'lutimesSync', 'mkdtempSync',
        'openSync', 'opendirSync', 'readSync', 'readlinkSync', 'realpathSync',
        'symlinkSync', 'truncateSync', 'utimesSync', 'writeSync', 'cpSync',
        'statfsSync', 'globSync',
        // Async callback methods
        'readFile', 'writeFile', 'appendFile', 'copyFile', 'rename', 'unlink',
        'mkdir', 'rmdir', 'rm', 'readdir', 'stat', 'lstat', 'access', 'chmod',
        'chown', 'close', 'fchmod', 'fchown', 'fdatasync', 'fstat', 'fsync',
        'ftruncate', 'futimes', 'link', 'lutimes', 'mkdtemp', 'open', 'opendir',
        'read', 'readlink', 'realpath', 'symlink', 'truncate', 'utimes', 'write',
        'cp', 'statfs', 'glob',
        // Streams
        'createReadStream', 'createWriteStream',
        // Watch
        'watch', 'watchFile', 'unwatchFile',
        // Constants & promises
        'constants', 'promises',
    ]),
    path: new Set([
        'basename', 'delimiter', 'dirname', 'extname', 'format', 'isAbsolute',
        'join', 'normalize', 'parse', 'posix', 'relative', 'resolve', 'sep',
        'toNamespacedPath', 'win32', 'matchesGlob',
    ]),
    crypto: new Set([
        'createHash', 'createHmac', 'createCipheriv', 'createDecipheriv',
        'createSign', 'createVerify', 'createDiffieHellman', 'createDiffieHellmanGroup',
        'createECDH', 'createSecretKey', 'createPublicKey', 'createPrivateKey',
        'generateKey', 'generateKeyPair', 'generateKeyPairSync', 'generateKeySync',
        'generatePrime', 'generatePrimeSync',
        'getCiphers', 'getCurves', 'getDiffieHellman', 'getFips', 'getHashes',
        'getRandomValues', 'hash',
        'hkdf', 'hkdfSync',
        'pbkdf2', 'pbkdf2Sync',
        'privateDecrypt', 'privateEncrypt', 'publicDecrypt', 'publicEncrypt',
        'randomBytes', 'randomFillSync', 'randomFill', 'randomInt', 'randomUUID',
        'scrypt', 'scryptSync',
        'setEngine', 'setFips',
        'sign', 'verify',
        'subtle', 'timingSafeEqual',
        'constants', 'webcrypto', 'X509Certificate',
        'checkPrime', 'checkPrimeSync',
        'Certificate', 'Cipher', 'Decipher', 'DiffieHellman', 'DiffieHellmanGroup',
        'ECDH', 'Hash', 'Hmac', 'KeyObject', 'Sign', 'Verify',
    ]),
    os: new Set([
        'arch', 'availableParallelism', 'constants', 'cpus', 'devNull',
        'endianness', 'EOL', 'freemem', 'getPriority', 'homedir',
        'hostname', 'loadavg', 'machine', 'networkInterfaces', 'platform',
        'release', 'setPriority', 'tmpdir', 'totalmem', 'type',
        'uptime', 'userInfo', 'version',
    ]),
    child_process: new Set([
        'exec', 'execFile', 'execFileSync', 'execSync',
        'fork', 'spawn', 'spawnSync',
    ]),
    http: new Set([
        'createServer', 'get', 'globalAgent', 'request',
        'Agent', 'ClientRequest', 'Server', 'ServerResponse', 'IncomingMessage',
        'METHODS', 'STATUS_CODES', 'maxHeaderSize', 'validateHeaderName', 'validateHeaderValue',
        'setMaxIdleHTTPParsers',
    ]),
    https: new Set([
        'createServer', 'get', 'globalAgent', 'request',
        'Agent', 'Server',
    ]),
    url: new Set([
        'domainToASCII', 'domainToUnicode', 'fileURLToPath', 'format',
        'pathToFileURL', 'resolve', 'URL', 'URLSearchParams',
        // Deprecated but still exist
        'parse', 'Url',
    ]),
    util: new Set([
        'callbackify', 'debuglog', 'deprecate', 'format', 'formatWithOptions',
        'getSystemErrorName', 'getSystemErrorMap', 'inherits', 'inspect',
        'isDeepStrictEqual', 'parseArgs', 'parseEnv', 'promisify',
        'stripVTControlCharacters', 'styleText',
        'TextDecoder', 'TextEncoder', 'MIMEType', 'MIMEParams',
        'types', 'toUSVString', 'transferableAbortController', 'transferableAbortSignal',
        'aborted',
    ]),
    stream: new Set([
        'Readable', 'Writable', 'Duplex', 'Transform', 'PassThrough',
        'pipeline', 'finished', 'compose', 'addAbortSignal',
        'getDefaultHighWaterMark', 'setDefaultHighWaterMark',
        'promises', 'consumers',
    ]),
    events: new Set([
        'EventEmitter', 'once', 'on', 'getEventListeners',
        'setMaxListeners', 'listenerCount', 'addAbortListener',
        'getMaxListeners', 'EventEmitterAsyncResource',
    ]),
    buffer: new Set([
        'Buffer', 'SlowBuffer', 'transcode',
        'constants', 'kMaxLength', 'kStringMaxLength',
        'atob', 'btoa', 'isAscii', 'isUtf8', 'resolveObjectURL',
        'Blob', 'File',
    ]),
    querystring: new Set([
        'decode', 'encode', 'escape', 'parse', 'stringify', 'unescape',
    ]),
    net: new Set([
        'createServer', 'createConnection', 'connect',
        'isIP', 'isIPv4', 'isIPv6',
        'Server', 'Socket', 'BlockList', 'SocketAddress',
        'getDefaultAutoSelectFamily', 'setDefaultAutoSelectFamily',
        'getDefaultAutoSelectFamilyAttemptTimeout', 'setDefaultAutoSelectFamilyAttemptTimeout',
    ]),
    dns: new Set([
        'lookup', 'lookupService', 'resolve', 'resolve4', 'resolve6',
        'resolveAny', 'resolveCname', 'resolveCaa', 'resolveMx', 'resolveNaptr',
        'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt',
        'reverse', 'setServers', 'getServers', 'setDefaultResultOrder',
        'getDefaultResultOrder',
        'promises', 'Resolver', 'ADDRCONFIG', 'V4MAPPED', 'ALL',
    ]),
    tls: new Set([
        'createServer', 'connect', 'createSecureContext', 'createSecurePair',
        'getCiphers', 'rootCertificates', 'DEFAULT_ECDH_CURVE', 'DEFAULT_MAX_VERSION',
        'DEFAULT_MIN_VERSION', 'DEFAULT_CIPHERS',
        'Server', 'TLSSocket', 'SecureContext',
    ]),
    zlib: new Set([
        'createGzip', 'createGunzip', 'createDeflate', 'createInflate',
        'createDeflateRaw', 'createInflateRaw', 'createBrotliCompress',
        'createBrotliDecompress', 'createUnzip',
        'gzip', 'gunzip', 'deflate', 'inflate', 'deflateRaw', 'inflateRaw',
        'brotliCompress', 'brotliDecompress', 'unzip',
        'gzipSync', 'gunzipSync', 'deflateSync', 'inflateSync',
        'deflateRawSync', 'inflateRawSync', 'brotliCompressSync',
        'brotliDecompressSync', 'unzipSync',
        'constants',
    ]),
    readline: new Set([
        'createInterface', 'clearLine', 'clearScreenDown', 'cursorTo',
        'moveCursor', 'emitKeypressEvents',
        'Interface', 'InterfaceConstructor', 'promises',
    ]),
    cluster: new Set([
        'disconnect', 'fork', 'isMaster', 'isPrimary', 'isWorker',
        'schedulingPolicy', 'settings', 'setupMaster', 'setupPrimary',
        'worker', 'workers',
        'Worker', 'SCHED_NONE', 'SCHED_RR',
    ]),
    worker_threads: new Set([
        'isMainThread', 'parentPort', 'resourceLimits', 'threadId',
        'workerData', 'getEnvironmentData', 'setEnvironmentData',
        'markAsUntransferable', 'moveMessagePortToContext', 'receiveMessageOnPort',
        'BroadcastChannel', 'MessageChannel', 'MessagePort', 'Worker',
        'SHARE_ENV',
    ]),
    timers: new Set([
        'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
        'setImmediate', 'clearImmediate',
        'promises',
    ]),
    perf_hooks: new Set([
        'performance', 'PerformanceObserver', 'PerformanceEntry',
        'PerformanceMark', 'PerformanceMeasure', 'PerformanceNodeTiming',
        'PerformanceResourceTiming', 'monitorEventLoopDelay',
        'createHistogram',
    ]),
    assert: new Set([
        'ok', 'fail', 'equal', 'notEqual', 'deepEqual', 'notDeepEqual',
        'deepStrictEqual', 'notDeepStrictEqual', 'strictEqual', 'notStrictEqual',
        'throws', 'doesNotThrow', 'rejects', 'doesNotReject',
        'ifError', 'match', 'doesNotMatch',
        'strict', 'AssertionError', 'CallTracker',
    ]),
};

/**
 * Python 3.12+ stdlib method signatures.
 * Covers the most commonly hallucinated modules.
 */
export const PYTHON_STDLIB_METHODS: Record<string, Set<string>> = {
    os: new Set([
        'getcwd', 'chdir', 'listdir', 'scandir', 'mkdir', 'makedirs',
        'rmdir', 'removedirs', 'remove', 'unlink', 'rename', 'renames',
        'replace', 'stat', 'lstat', 'fstat', 'chmod', 'chown', 'link',
        'symlink', 'readlink', 'walk', 'fwalk', 'path', 'environ',
        'getenv', 'putenv', 'unsetenv', 'getpid', 'getppid', 'getuid',
        'getgid', 'system', 'popen', 'execv', 'execve', 'execvp',
        'execvpe', '_exit', 'fork', 'kill', 'wait', 'waitpid',
        'cpu_count', 'urandom', 'sep', 'linesep', 'devnull', 'curdir',
        'pardir', 'extsep', 'altsep', 'pathsep', 'name', 'access',
        'open', 'close', 'read', 'write', 'pipe', 'dup', 'dup2',
        'ftruncate', 'isatty', 'lseek', 'terminal_size', 'get_terminal_size',
        'get_blocking', 'set_blocking', 'add_dll_directory',
        'get_exec_path', 'getlogin', 'strerror', 'umask',
        'truncate', 'fchdir', 'fchmod', 'fchown',
    ]),
    json: new Set([
        'dump', 'dumps', 'load', 'loads',
        'JSONDecoder', 'JSONEncoder', 'JSONDecodeError',
        'tool',
    ]),
    sys: new Set([
        'argv', 'exit', 'path', 'modules', 'stdin', 'stdout', 'stderr',
        'version', 'version_info', 'platform', 'executable', 'prefix',
        'exec_prefix', 'maxsize', 'maxunicode', 'byteorder', 'builtin_module_names',
        'flags', 'float_info', 'hash_info', 'implementation', 'int_info',
        'getdefaultencoding', 'getfilesystemencoding', 'getrecursionlimit',
        'getrefcount', 'getsizeof', 'gettrace', 'getprofile',
        'setrecursionlimit', 'settrace', 'setprofile',
        'exc_info', 'last_type', 'last_value', 'last_traceback',
        'api_version', 'copyright', 'dont_write_bytecode',
        'ps1', 'ps2', 'intern', 'is_finalizing',
        'orig_argv', 'platlibdir', 'stdlib_module_names',
        'thread_info', 'unraisablehook', 'winver',
        'addaudithook', 'audit', 'breakpointhook',
        'call_tracing', 'displayhook', 'excepthook',
        'get_asyncgen_hooks', 'get_coroutine_origin_tracking_depth',
        'getallocatedblocks', 'getwindowsversion',
        'set_asyncgen_hooks', 'set_coroutine_origin_tracking_depth',
        'set_int_max_str_digits', 'get_int_max_str_digits',
        'activate_stack_trampoline', 'deactivate_stack_trampoline',
        'is_stack_trampoline_active', 'last_exc',
        'monitoring', 'exception',
    ]),
    re: new Set([
        'compile', 'search', 'match', 'fullmatch', 'split', 'findall',
        'finditer', 'sub', 'subn', 'escape', 'purge', 'error',
        'Pattern', 'Match',
        'A', 'ASCII', 'DEBUG', 'DOTALL', 'I', 'IGNORECASE',
        'L', 'LOCALE', 'M', 'MULTILINE', 'NOFLAG',
        'S', 'U', 'UNICODE', 'VERBOSE', 'X',
    ]),
    math: new Set([
        'ceil', 'comb', 'copysign', 'fabs', 'factorial', 'floor',
        'fmod', 'frexp', 'fsum', 'gcd', 'isclose', 'isfinite',
        'isinf', 'isnan', 'isqrt', 'lcm', 'ldexp', 'log', 'log10',
        'log1p', 'log2', 'modf', 'perm', 'pow', 'prod', 'remainder',
        'trunc', 'ulp', 'nextafter', 'sumprod',
        'exp', 'exp2', 'expm1', 'sqrt', 'cbrt',
        'acos', 'acosh', 'asin', 'asinh', 'atan', 'atan2', 'atanh',
        'cos', 'cosh', 'degrees', 'dist', 'hypot', 'radians',
        'sin', 'sinh', 'tan', 'tanh',
        'erf', 'erfc', 'gamma', 'lgamma',
        'pi', 'e', 'tau', 'inf', 'nan',
    ]),
    datetime: new Set([
        'date', 'time', 'datetime', 'timedelta', 'timezone', 'tzinfo',
        'MINYEAR', 'MAXYEAR', 'UTC',
    ]),
    pathlib: new Set([
        'Path', 'PurePath', 'PurePosixPath', 'PureWindowsPath',
        'PosixPath', 'WindowsPath',
    ]),
    subprocess: new Set([
        'run', 'call', 'check_call', 'check_output', 'Popen',
        'PIPE', 'STDOUT', 'DEVNULL', 'CompletedProcess',
        'CalledProcessError', 'SubprocessError', 'TimeoutExpired',
        'getoutput', 'getstatusoutput',
    ]),
    shutil: new Set([
        'copy', 'copy2', 'copyfile', 'copyfileobj', 'copymode', 'copystat',
        'copytree', 'rmtree', 'move', 'disk_usage', 'chown', 'which',
        'make_archive', 'get_archive_formats', 'register_archive_format',
        'unregister_archive_format', 'unpack_archive', 'get_unpack_formats',
        'register_unpack_format', 'unregister_unpack_format',
        'get_terminal_size', 'SameFileError',
    ]),
    collections: new Set([
        'ChainMap', 'Counter', 'OrderedDict', 'UserDict', 'UserList',
        'UserString', 'abc', 'defaultdict', 'deque', 'namedtuple',
    ]),
    hashlib: new Set([
        'md5', 'sha1', 'sha224', 'sha256', 'sha384', 'sha512',
        'sha3_224', 'sha3_256', 'sha3_384', 'sha3_512',
        'blake2b', 'blake2s', 'shake_128', 'shake_256',
        'new', 'algorithms_available', 'algorithms_guaranteed',
        'pbkdf2_hmac', 'scrypt', 'file_digest',
    ]),
    random: new Set([
        'seed', 'getstate', 'setstate', 'getrandbits',
        'randrange', 'randint', 'choice', 'choices', 'shuffle', 'sample',
        'random', 'uniform', 'triangular', 'betavariate', 'expovariate',
        'gammavariate', 'gauss', 'lognormvariate', 'normalvariate',
        'vonmisesvariate', 'paretovariate', 'weibullvariate',
        'Random', 'SystemRandom', 'randbytes',
    ]),
    time: new Set([
        'time', 'time_ns', 'clock_gettime', 'clock_gettime_ns',
        'clock_settime', 'clock_settime_ns', 'clock_getres',
        'gmtime', 'localtime', 'mktime', 'asctime', 'ctime',
        'strftime', 'strptime', 'sleep', 'monotonic', 'monotonic_ns',
        'perf_counter', 'perf_counter_ns', 'process_time', 'process_time_ns',
        'thread_time', 'thread_time_ns', 'get_clock_info',
        'struct_time', 'timezone', 'altzone', 'daylight', 'tzname',
        'CLOCK_BOOTTIME', 'CLOCK_MONOTONIC', 'CLOCK_MONOTONIC_RAW',
        'CLOCK_PROCESS_CPUTIME_ID', 'CLOCK_REALTIME',
        'CLOCK_TAI', 'CLOCK_THREAD_CPUTIME_ID',
    ]),
    csv: new Set([
        'reader', 'writer', 'DictReader', 'DictWriter',
        'Sniffer', 'register_dialect', 'unregister_dialect',
        'get_dialect', 'list_dialects', 'field_size_limit',
        'QUOTE_ALL', 'QUOTE_MINIMAL', 'QUOTE_NONNUMERIC', 'QUOTE_NONE',
        'QUOTE_NOTNULL', 'QUOTE_STRINGS',
        'Dialect', 'Error', 'excel', 'excel_tab', 'unix_dialect',
    ]),
    logging: new Set([
        'getLogger', 'basicConfig', 'shutdown', 'setLoggerClass',
        'setLogRecordFactory', 'lastResort', 'captureWarnings',
        'debug', 'info', 'warning', 'error', 'critical', 'exception',
        'log', 'disable', 'addLevelName', 'getLevelName', 'getLevelNamesMapping',
        'makeLogRecord', 'getHandlerByName', 'getHandlerNames',
        'Logger', 'Handler', 'Formatter', 'Filter', 'LogRecord',
        'StreamHandler', 'FileHandler', 'NullHandler',
        'BufferingFormatter', 'LoggerAdapter', 'PercentStyle',
        'StrFormatStyle', 'StringTemplateStyle',
        'DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL',
        'FATAL', 'WARN', 'NOTSET',
        'raiseExceptions', 'root',
        'handlers', 'config',
    ]),
};
