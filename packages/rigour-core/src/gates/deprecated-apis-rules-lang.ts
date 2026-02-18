/**
 * Language-specific deprecated APIs: Python, Go, C#, Java
 * Extracted to keep deprecated-apis.ts under 500 lines.
 */

import { DeprecatedRule } from './deprecated-apis-rules-node.js';

/**
 * Python deprecated APIs — sourced from Python 3.12+ deprecation notices
 */
export const PYTHON_DEPRECATED_RULES: DeprecatedRule[] = [
    // Security-deprecated
    {
        pattern: /\bmd5\s*\(|\.md5\s*\(/,
        api: 'hashlib.md5() for passwords',
        reason: 'MD5 is cryptographically broken — collision attacks proven since 2004',
        replacement: 'hashlib.sha256(), hashlib.blake2b(), or bcrypt/argon2 for passwords',
        category: 'security',
    },
    {
        pattern: /\bsha1\s*\(|\.sha1\s*\(/,
        api: 'hashlib.sha1() for security',
        reason: 'SHA-1 is cryptographically broken — SHAttered attack (2017)',
        replacement: 'hashlib.sha256() or hashlib.sha3_256()',
        category: 'security',
    },
    {
        pattern: /\bpickle\.loads?\s*\(/,
        api: 'pickle.load()/loads()',
        reason: 'Arbitrary code execution vulnerability when loading untrusted data',
        replacement: 'json.loads() for data, or use restricted_loads with allowlists',
        category: 'security',
    },
    {
        pattern: /\byaml\.load\s*\([^)]*(?!\bLoader\b)[^)]*\)/,
        api: 'yaml.load() without Loader',
        reason: 'Arbitrary code execution when loading untrusted YAML',
        replacement: 'yaml.safe_load() or yaml.load(data, Loader=yaml.SafeLoader)',
        category: 'security',
    },
    {
        pattern: /\bexec\s*\(\s*(?:input|request|f['"])/,
        api: 'exec() with user input',
        reason: 'Code injection vulnerability',
        replacement: 'ast.literal_eval() for data, structured parsing for expressions',
        category: 'security',
    },
    {
        pattern: /\bos\.system\s*\(/,
        api: 'os.system()',
        reason: 'Shell injection vulnerability, no output capture',
        replacement: 'subprocess.run() with shell=False',
        category: 'security',
    },
    {
        pattern: /subprocess\.(?:call|run|Popen)\s*\([^)]*shell\s*=\s*True/,
        api: 'subprocess with shell=True',
        reason: 'Shell injection vulnerability when args contain user input',
        replacement: 'subprocess.run() with shell=False and list args',
        category: 'security',
    },
    // Removed modules (Python 3.12+)
    {
        pattern: /\bimport\s+imp\b/,
        api: 'import imp',
        reason: 'Removed in Python 3.12 (PEP 594)',
        replacement: 'importlib',
        category: 'removed',
    },
    {
        pattern: /\bimport\s+(?:aifc|audioop|cgi|cgitb|chunk|crypt|imghdr|mailcap|msilib|nis|nntplib|ossaudiodev|pipes|sndhdr|spwd|sunau|telnetlib|uu|xdrlib)\b/,
        api: 'Dead batteries module',
        reason: 'Removed in Python 3.13 (PEP 594 — dead batteries)',
        replacement: 'PyPI equivalents (see PEP 594 for specific replacements)',
        category: 'removed',
    },
    {
        pattern: /\bfrom\s+distutils\b/,
        api: 'distutils',
        reason: 'Removed in Python 3.12 (PEP 632)',
        replacement: 'setuptools or build',
        category: 'removed',
    },
    {
        pattern: /\bimport\s+formatter\b/,
        api: 'import formatter',
        reason: 'Removed in Python 3.10',
        replacement: 'No direct replacement — use string formatting',
        category: 'removed',
    },
    // Superseded
    {
        pattern: /\bfrom\s+collections\s+import\s+(?:Mapping|MutableMapping|Sequence|MutableSequence|Set|MutableSet|Callable|Iterable|Iterator|Generator|Coroutine|Awaitable|AsyncIterable|AsyncIterator|AsyncGenerator|Hashable|Sized|Container|Collection|Reversible|MappingView|KeysView|ItemsView|ValuesView|ByteString)\b/,
        api: 'collections ABCs',
        reason: 'Removed in Python 3.10 — moved to collections.abc',
        replacement: 'from collections.abc import ...',
        category: 'removed',
    },
    {
        pattern: /\boptparse\b/,
        api: 'optparse',
        reason: 'Superseded since Python 3.2',
        replacement: 'argparse',
        category: 'superseded',
    },
    {
        pattern: /\bfrom\s+typing\s+import\s+(?:Dict|List|Set|Tuple|FrozenSet|Type|Deque|DefaultDict|OrderedDict|Counter|ChainMap|Awaitable|Coroutine|AsyncIterable|AsyncIterator|AsyncGenerator|Iterable|Iterator|Generator|Reversible|Container|Collection|Callable|AbstractSet|MutableSet|Mapping|MutableMapping|Sequence|MutableSequence|ByteString|MappingView|KeysView|ItemsView|ValuesView|ContextManager|AsyncContextManager|Pattern|Match)\b/,
        api: 'typing generics (Dict, List, etc.)',
        reason: 'Deprecated since Python 3.9 — use built-in generics (PEP 585)',
        replacement: 'dict[], list[], set[], tuple[] (lowercase built-in types)',
        category: 'superseded',
    },
    {
        pattern: /\bfrom\s+typing\s+import\s+(?:Optional|Union)\b/,
        api: 'typing.Optional / typing.Union',
        reason: 'Superseded in Python 3.10 — use X | Y syntax (PEP 604)',
        replacement: 'X | None instead of Optional[X], X | Y instead of Union[X, Y]',
        category: 'superseded',
    },
    {
        pattern: /\basyncio\.get_event_loop\s*\(\s*\)/,
        api: 'asyncio.get_event_loop()',
        reason: 'Deprecated in Python 3.10 — may create new loop unexpectedly',
        replacement: 'asyncio.get_running_loop() or asyncio.run()',
        category: 'superseded',
    },
    {
        pattern: /\bsetup\s*\(\s*[^)]*\buse_2to3\s*=/,
        api: 'setup(use_2to3=True)',
        reason: 'Removed in setuptools 58+ — Python 2 support dropped',
        replacement: 'Write Python 3 only code',
        category: 'removed',
    },
];

/**
 * Go deprecated APIs — sourced from Go official deprecation notices
 */
export const GO_DEPRECATED_RULES: DeprecatedRule[] = [
    {
        pattern: /\bioutil\.ReadFile\s*\(/,
        api: 'ioutil.ReadFile()', reason: 'Deprecated since Go 1.16 — io/ioutil package deprecated',
        replacement: 'os.ReadFile()', category: 'superseded',
    },
    {
        pattern: /\bioutil\.WriteFile\s*\(/,
        api: 'ioutil.WriteFile()', reason: 'Deprecated since Go 1.16',
        replacement: 'os.WriteFile()', category: 'superseded',
    },
    {
        pattern: /\bioutil\.ReadAll\s*\(/,
        api: 'ioutil.ReadAll()', reason: 'Deprecated since Go 1.16',
        replacement: 'io.ReadAll()', category: 'superseded',
    },
    {
        pattern: /\bioutil\.ReadDir\s*\(/,
        api: 'ioutil.ReadDir()', reason: 'Deprecated since Go 1.16',
        replacement: 'os.ReadDir()', category: 'superseded',
    },
    {
        pattern: /\bioutil\.TempDir\s*\(/,
        api: 'ioutil.TempDir()', reason: 'Deprecated since Go 1.17',
        replacement: 'os.MkdirTemp()', category: 'superseded',
    },
    {
        pattern: /\bioutil\.TempFile\s*\(/,
        api: 'ioutil.TempFile()', reason: 'Deprecated since Go 1.17',
        replacement: 'os.CreateTemp()', category: 'superseded',
    },
    {
        pattern: /\bioutil\.NopCloser\s*\(/,
        api: 'ioutil.NopCloser()', reason: 'Deprecated since Go 1.16',
        replacement: 'io.NopCloser()', category: 'superseded',
    },
    {
        pattern: /\b"io\/ioutil"/,
        api: 'import "io/ioutil"', reason: 'Entire io/ioutil package deprecated since Go 1.16',
        replacement: 'Use os and io packages instead', category: 'superseded',
    },
    {
        pattern: /\bsort\.IntSlice\b|sort\.Float64Slice\b|sort\.StringSlice\b/,
        api: 'sort.*Slice types', reason: 'Superseded since Go 1.21',
        replacement: 'slices.Sort() or sort.Slice()', category: 'superseded',
    },
    {
        pattern: /\bmath\/rand"[\s\S]*?rand\.(Seed|Read)\s*\(/,
        api: 'rand.Seed() / rand.Read()', reason: 'Deprecated in Go 1.20+',
        replacement: 'Auto-seeded in Go 1.20+; use crypto/rand.Read()', category: 'superseded',
    },
    {
        pattern: /\bstrings\.Title\s*\(/,
        api: 'strings.Title()', reason: 'Deprecated since Go 1.18 — broken for Unicode',
        replacement: 'golang.org/x/text/cases.Title()', category: 'superseded',
    },
];

/**
 * C# deprecated APIs — sourced from .NET deprecation notices
 */
export const CSHARP_DEPRECATED_RULES: DeprecatedRule[] = [
    {
        pattern: /\bnew\s+WebClient\s*\(/,
        api: 'WebClient', reason: 'Deprecated in .NET 6+ — poor async support',
        replacement: 'HttpClient', category: 'superseded',
    },
    {
        pattern: /\bBinaryFormatter\b/,
        api: 'BinaryFormatter', reason: 'Security vulnerability — arbitrary code execution on deserialization',
        replacement: 'System.Text.Json or JsonSerializer', category: 'security',
    },
    {
        pattern: /\bJavaScriptSerializer\b/,
        api: 'JavaScriptSerializer', reason: 'Deprecated — poor performance and limited features',
        replacement: 'System.Text.Json.JsonSerializer', category: 'superseded',
    },
    {
        pattern: /\bThread\.Abort\s*\(/,
        api: 'Thread.Abort()', reason: 'Throws PlatformNotSupportedException in .NET 5+',
        replacement: 'CancellationToken for cooperative cancellation', category: 'removed',
    },
    {
        pattern: /\bThread\.Suspend\s*\(|Thread\.Resume\s*\(/,
        api: 'Thread.Suspend/Resume()', reason: 'Deprecated — causes deadlocks',
        replacement: 'ManualResetEvent or SemaphoreSlim', category: 'removed',
    },
    {
        pattern: /\bAppDomain\.CreateDomain\s*\(/,
        api: 'AppDomain.CreateDomain()', reason: 'Not supported in .NET Core/5+',
        replacement: 'AssemblyLoadContext', category: 'removed',
    },
    {
        pattern: /\bRemoting\b.*\bChannel\b/,
        api: '.NET Remoting', reason: 'Removed in .NET Core/5+',
        replacement: 'gRPC, REST APIs, or SignalR', category: 'removed',
    },
    {
        pattern: /\bnew\s+SHA1(?:Managed|CryptoServiceProvider)\s*\(/,
        api: 'SHA1Managed/CryptoServiceProvider', reason: 'SHA-1 cryptographically broken',
        replacement: 'SHA256.Create() or SHA512.Create()', category: 'security',
    },
    {
        pattern: /\bnew\s+MD5CryptoServiceProvider\s*\(/,
        api: 'MD5CryptoServiceProvider', reason: 'MD5 cryptographically broken',
        replacement: 'SHA256.Create() or SHA512.Create()', category: 'security',
    },
    {
        pattern: /\bnew\s+(?:RijndaelManaged|DESCryptoServiceProvider|RC2CryptoServiceProvider|TripleDESCryptoServiceProvider)\s*\(/,
        api: 'Legacy crypto providers', reason: 'Weak encryption algorithms',
        replacement: 'Aes.Create()', category: 'security',
    },
];

/**
 * Java deprecated APIs — sourced from JDK deprecation notices
 */
export const JAVA_DEPRECATED_RULES: DeprecatedRule[] = [
    {
        pattern: /\bnew\s+Date\s*\(\s*\d/,
        api: 'new Date(year, month, ...)', reason: 'Deprecated since JDK 1.1',
        replacement: 'java.time.LocalDate, LocalDateTime, ZonedDateTime', category: 'superseded',
    },
    {
        pattern: /\bnew\s+Vector\s*[<(]/,
        api: 'Vector', reason: 'Legacy synchronized collection — poor performance',
        replacement: 'ArrayList (or Collections.synchronizedList())', category: 'superseded',
    },
    {
        pattern: /\bnew\s+Hashtable\s*[<(]/,
        api: 'Hashtable', reason: 'Legacy synchronized map — poor performance',
        replacement: 'HashMap (or ConcurrentHashMap)', category: 'superseded',
    },
    {
        pattern: /\bnew\s+Stack\s*[<(]/,
        api: 'Stack', reason: 'Legacy class — extends Vector unnecessarily',
        replacement: 'Deque<> (ArrayDeque) with push/pop', category: 'superseded',
    },
    {
        pattern: /\bnew\s+StringBuffer\s*\(/,
        api: 'StringBuffer', reason: 'Unnecessarily synchronized — slower than StringBuilder',
        replacement: 'StringBuilder (unless thread safety needed)', category: 'superseded',
    },
    {
        pattern: /\.getYear\s*\(\s*\)(?!.*java\.time)/,
        api: 'Date.getYear()', reason: 'Deprecated since JDK 1.1 — returns year - 1900',
        replacement: 'LocalDate.now().getYear()', category: 'superseded',
    },
    {
        pattern: /Thread\.stop\s*\(/i,
        api: 'Thread.stop()', reason: 'Deprecated — unsafe, can corrupt objects',
        replacement: 'Thread.interrupt() with cooperative checking', category: 'security',
    },
    {
        pattern: /Thread\.destroy\s*\(|Thread\.suspend\s*\(|Thread\.resume\s*\(/,
        api: 'Thread.destroy/suspend/resume()', reason: 'Deprecated — deadlock-prone',
        replacement: 'Thread.interrupt() and wait/notify', category: 'removed',
    },
    {
        pattern: /Runtime\.runFinalizersOnExit\s*\(/,
        api: 'Runtime.runFinalizersOnExit()', reason: 'Deprecated — inherently unsafe',
        replacement: 'Runtime shutdown hooks or try-with-resources', category: 'removed',
    },
    {
        pattern: /\bfinalize\s*\(\s*\)\s*(?:throws|\{)/,
        api: 'finalize()', reason: 'Deprecated since Java 9 (JEP 421) — for removal',
        replacement: 'Cleaner or try-with-resources (AutoCloseable)', category: 'superseded',
    },
    {
        pattern: /\bnew\s+Integer\s*\(|new\s+Long\s*\(|new\s+Double\s*\(|new\s+Boolean\s*\(|new\s+Float\s*\(/,
        api: 'new Integer/Long/Double/Boolean/Float()', reason: 'Deprecated since Java 9 — valueOf preferred',
        replacement: 'Integer.valueOf(), autoboxing, or parse methods', category: 'superseded',
    },
    {
        pattern: /\bSecurityManager\b/,
        api: 'SecurityManager', reason: 'Deprecated for removal since Java 17 (JEP 411)',
        replacement: 'No direct replacement — use OS-level security', category: 'removed',
    },
];
