/**
 * Side-Effect Analysis Rules
 *
 * Pattern definitions for detecting unbounded side effects that cause
 * real-world consequences: process spawns, resource exhaustion, circular
 * triggers, missing circuit breakers.
 *
 * Each rule has:
 * - regex patterns per language
 * - a check function that verifies context (surrounding lines)
 * - severity and description
 *
 */

export type SideEffectLang = 'js' | 'ts' | 'py' | 'go' | 'rs' | 'cs' | 'java' | 'rb';

export interface SideEffectViolation {
    rule: string;
    severity: 'critical' | 'high' | 'medium' | 'low';
    file: string;
    line: number;
    match: string;
    description: string;
    hint: string;
}

// ── Language detection ──

export const LANG_MAP: Record<string, SideEffectLang> = {
    '.ts': 'ts', '.tsx': 'ts', '.mts': 'ts',
    '.js': 'js', '.jsx': 'js', '.mjs': 'js', '.cjs': 'js',
    '.py': 'py',
    '.go': 'go',
    '.rs': 'rs',
    '.cs': 'cs',
    '.java': 'java',
    '.rb': 'rb',
};

export const FILE_GLOBS = [
    '**/*.{ts,tsx,mts,js,jsx,mjs,cjs}',
    '**/*.py',
    '**/*.go',
    '**/*.rs',
    '**/*.cs',
    '**/*.java',
    '**/*.rb',
];

// ── Timer patterns (setInterval/setTimeout without cleanup) ──

export const TIMER_CREATE_PATTERNS: Record<string, RegExp[]> = {
    js: [
        /\bsetInterval\s*\(/,
        /\bsetTimeout\s*\(/,
    ],
    ts: [
        /\bsetInterval\s*\(/,
        /\bsetTimeout\s*\(/,
    ],
    py: [
        /\bscheduler\.enter\s*\(/,
        /\bTimer\s*\(/,
        /\bschedule\.every\b/,
    ],
    go: [
        /\btime\.NewTicker\s*\(/,
        /\btime\.Tick\s*\(/,
    ],
    java: [
        /\bScheduledExecutorService\b/,
        /\bTimer\(\)\.schedule\b/,
        /\bTimer\(\)\.scheduleAtFixedRate\b/,
    ],
    rs: [],
    cs: [
        /\bnew\s+Timer\s*\(/,
        /\bSetInterval\s*\(/,
    ],
    rb: [],
};

export const TIMER_CLEANUP_PATTERNS: Record<string, RegExp[]> = {
    js: [/\bclearInterval\s*\(/, /\bclearTimeout\s*\(/],
    ts: [/\bclearInterval\s*\(/, /\bclearTimeout\s*\(/],
    py: [/\.cancel\s*\(/],
    go: [/\.Stop\s*\(/],
    java: [/\.shutdown\s*\(/, /\.cancel\s*\(/],
    rs: [],
    cs: [/\.Dispose\s*\(/, /\.Stop\s*\(/],
    rb: [],
};

// ── Process spawn patterns ──

export const PROCESS_SPAWN_PATTERNS: Record<string, RegExp[]> = {
    js: [
        /\bchild_process\.\w+\s*\(/,
        /\bspawn\s*\(/,
        /\bexec\s*\(/,
        /\bexecFile\s*\(/,
        /\bfork\s*\(/,
        /\bexeca\s*\(/,
    ],
    ts: [
        /\bchild_process\.\w+\s*\(/,
        /\bspawn\s*\(/,
        /\bexec\s*\(/,
        /\bexecFile\s*\(/,
        /\bfork\s*\(/,
        /\bexeca\s*\(/,
    ],
    py: [
        /\bsubprocess\.\w+\s*\(/,
        /\bPopen\s*\(/,
        /\bos\.system\s*\(/,
        /\bos\.exec\w*\s*\(/,
        /\bos\.spawn\w*\s*\(/,
    ],
    go: [
        /\bexec\.Command\s*\(/,
        /\bos\/exec\b/,
        /\bcmd\.Start\s*\(/,
        /\bcmd\.Run\s*\(/,
    ],
    java: [
        /\bProcessBuilder\b/,
        /\bRuntime\.getRuntime\(\)\.exec\s*\(/,
    ],
    rs: [
        /\bCommand::new\s*\(/,
        /\bstd::process::Command\b/,
    ],
    cs: [
        /\bProcess\.Start\s*\(/,
        /\bnew\s+ProcessStartInfo\b/,
    ],
    rb: [
        /\bsystem\s*\(/,
        /\bspawn\s*\(/,
        /\b`[^`]+`/,
        /\bIO\.popen\s*\(/,
    ],
};

export const PROCESS_EXIT_PATTERNS: Record<string, RegExp[]> = {
    js: [/\.on\s*\(\s*['"](?:exit|close)['"]/, /\.kill\s*\(/, /\.disconnect\s*\(/],
    ts: [/\.on\s*\(\s*['"](?:exit|close)['"]/, /\.kill\s*\(/, /\.disconnect\s*\(/],
    py: [/\.wait\s*\(/, /\.terminate\s*\(/, /\.kill\s*\(/, /\.communicate\s*\(/],
    go: [/\.Wait\s*\(/, /cmd\.Process\.Kill\s*\(/],
    java: [/\.waitFor\s*\(/, /\.destroy\s*\(/, /\.destroyForcibly\s*\(/],
    rs: [/\.wait\s*\(/, /\.kill\s*\(/],
    cs: [/\.WaitForExit\s*\(/, /\.Kill\s*\(/, /\.Close\s*\(/],
    rb: [/Process\.wait\b/, /Process\.kill\b/],
};

// ── Unbounded loop patterns ──

export const UNBOUNDED_LOOP_PATTERNS: Record<string, RegExp[]> = {
    js: [/\bwhile\s*\(\s*true\s*\)/, /\bwhile\s*\(\s*1\s*\)/, /\bfor\s*\(\s*;\s*;\s*\)/],
    ts: [/\bwhile\s*\(\s*true\s*\)/, /\bwhile\s*\(\s*1\s*\)/, /\bfor\s*\(\s*;\s*;\s*\)/],
    py: [/\bwhile\s+True\s*:/, /\bwhile\s+1\s*:/],
    go: [/\bfor\s*\{/, /\bfor\s+\{/],    // bare `for {` in Go = infinite loop
    java: [/\bwhile\s*\(\s*true\s*\)/, /\bfor\s*\(\s*;\s*;\s*\)/],
    rs: [/\bloop\s*\{/],
    cs: [/\bwhile\s*\(\s*true\s*\)/, /\bfor\s*\(\s*;\s*;\s*\)/],
    rb: [/\bloop\s+do\b/, /\bwhile\s+true\b/],
};

// I/O operations inside loops that indicate resource impact
export const IO_PATTERNS: Record<string, RegExp[]> = {
    js: [
        /\bfs\.\w+/, /\bfetch\s*\(/, /\baxios\.\w+/, /\bhttp\.\w+/,
        /\.write\s*\(/, /\.send\s*\(/, /\bchild_process\./,
        /\bconsole\.\w+/, /\bprocess\.stdout/,
    ],
    ts: [
        /\bfs\.\w+/, /\bfetch\s*\(/, /\baxios\.\w+/, /\bhttp\.\w+/,
        /\.write\s*\(/, /\.send\s*\(/, /\bchild_process\./,
    ],
    py: [
        /\bopen\s*\(/, /\brequests\.\w+/, /\burllib\.\w+/,
        /\bsubprocess\./, /\bos\.\w+/, /\bsocket\.\w+/,
        /\.write\s*\(/, /\bprint\s*\(/,
    ],
    go: [
        /\bos\.\w+/, /\bnet\.\w+/, /\bhttp\.\w+/,
        /\bio\.\w+/, /\bfmt\.Fprint/, /\bioutil\.\w+/,
        /\bexec\.Command/,
    ],
    java: [
        /\bnew\s+File\w*\(/, /\bHttpClient\b/, /\bSocket\b/,
        /\.write\s*\(/, /\bRuntime\.getRuntime\(\)/,
    ],
    rs: [
        /\bstd::fs::/, /\bstd::net::/, /\bstd::process::/,
        /\.write\s*\(/, /\btokio::\w+/,
    ],
    cs: [
        /\bFile\.\w+/, /\bHttpClient\b/, /\bProcess\.Start/,
        /\.Write\s*\(/, /\bSocket\b/,
    ],
    rb: [
        /\bFile\.\w+/, /\bNet::HTTP\b/, /\bIO\.\w+/,
        /\.write\s*\(/, /\bsystem\s*\(/,
    ],
};

// ── Retry without limit patterns ──

export const RETRY_PATTERNS: Record<string, RegExp[]> = {
    js: [/\bcatch\s*\([^)]*\)\s*\{/, /\.catch\s*\(/],
    ts: [/\bcatch\s*\([^)]*\)\s*\{/, /\.catch\s*\(/],
    py: [/\bexcept\s+\w+/, /\bexcept\s*:/],
    go: [/\bif\s+err\s*!=\s*nil\b/],
    java: [/\bcatch\s*\(\w+\s+\w+\)/, /\bcatch\s*\(\s*Exception\b/],
    rs: [/\.unwrap_or_else\s*\(/, /\bif\s+let\s+Err\b/],
    cs: [/\bcatch\s*\(\w+\b/, /\bcatch\s*\{/],
    rb: [/\brescue\b/],
};

export const MAX_RETRY_INDICATORS: RegExp[] = [
    /max.?retries?/i,
    /retry.?count/i,
    /retry.?limit/i,
    /attempt/i,
    /retries?\s*[<>=!]+\s*\d+/,
    /count\s*[<>=!]+\s*\d+/,
    /MAX_/,
    /backoff/i,
    /circuit.?breaker/i,
];

// ── File watcher patterns (circular trigger detection) ──

export const WATCHER_PATTERNS: Record<string, RegExp[]> = {
    js: [
        /\bfs\.watch\s*\(/, /\bfs\.watchFile\s*\(/,
        /\bchokidar\.watch\s*\(/, /\bnodemon\b/,
        /\bnew\s+FSWatcher\b/,
    ],
    ts: [
        /\bfs\.watch\s*\(/, /\bfs\.watchFile\s*\(/,
        /\bchokidar\.watch\s*\(/,
        /\bnew\s+FSWatcher\b/,
    ],
    py: [
        /\bwatchdog\b/, /\bObserver\s*\(/,
        /\binotify\b/, /\bwatchfiles\b/,
    ],
    go: [
        /\bfsnotify\.\w+/, /\bNewWatcher\s*\(/,
    ],
    java: [
        /\bWatchService\b/, /\bWatchKey\b/,
    ],
    rs: [
        /\bnotify::/, /\bRecommendedWatcher\b/,
    ],
    cs: [
        /\bFileSystemWatcher\b/, /\bnew\s+FileSystemWatcher\b/,
    ],
    rb: [
        /\bListen\.\w+/, /\brb-inotify\b/,
    ],
};

export const WRITE_PATTERNS: Record<string, RegExp[]> = {
    js: [/\bfs\.writeFile/, /\bfs\.appendFile/, /\bfs\.createWriteStream/, /\.write\s*\(/],
    ts: [/\bfs\.writeFile/, /\bfs\.appendFile/, /\bfs\.createWriteStream/, /\.write\s*\(/],
    py: [/\bopen\s*\([^)]*['"][wa]['"]/, /\.write\s*\(/, /\bshutil\.\w+/],
    go: [/\bos\.WriteFile/, /\bos\.Create/, /\bio\.WriteString/, /\.Write\s*\(/],
    java: [/\bFileWriter\b/, /\bBufferedWriter\b/, /\.write\s*\(/],
    rs: [/\bfs::write/, /\bFile::create/, /\.write_all\s*\(/],
    cs: [/\bFile\.Write/, /\bStreamWriter\b/, /\.Write\s*\(/],
    rb: [/\bFile\.write/, /\bFile\.open\s*\([^)]*['"]w['"]/, /\.write\s*\(/],
};

// ── Resource lifecycle patterns (open without close) ──

export const RESOURCE_OPEN_PATTERNS: Record<string, RegExp[]> = {
    js: [/\bfs\.open\s*\(/, /\bfs\.createReadStream\s*\(/, /\bfs\.createWriteStream\s*\(/],
    ts: [/\bfs\.open\s*\(/, /\bfs\.createReadStream\s*\(/, /\bfs\.createWriteStream\s*\(/],
    py: [/\bopen\s*\(/],
    go: [/\bos\.Open\s*\(/, /\bos\.Create\s*\(/, /\bos\.OpenFile\s*\(/],
    java: [/\bnew\s+FileInputStream\b/, /\bnew\s+FileOutputStream\b/, /\bnew\s+BufferedReader\b/],
    rs: [/\bFile::open\s*\(/, /\bFile::create\s*\(/],
    cs: [/\bFile\.Open\s*\(/, /\bnew\s+FileStream\b/, /\bnew\s+StreamReader\b/],
    rb: [/\bFile\.open\s*\(/],
};

export const RESOURCE_CLOSE_PATTERNS: Record<string, RegExp[]> = {
    js: [/\.close\s*\(/, /\.destroy\s*\(/, /\.end\s*\(/],
    ts: [/\.close\s*\(/, /\.destroy\s*\(/, /\.end\s*\(/],
    py: [/\.close\s*\(/, /\bwith\s+open\b/],  // `with` auto-closes
    go: [/\.Close\s*\(/, /\bdefer\b/],         // defer auto-closes
    java: [/\.close\s*\(/, /\btry\s*\(/],      // try-with-resources
    rs: [/\bdrop\s*\(/, /\}$/],                 // Rust auto-drops
    cs: [/\.Close\s*\(/, /\.Dispose\s*\(/, /\busing\s*\(/],  // using auto-disposes
    rb: [/\.close\b/, /\bFile\.open\s*\([^)]*\)\s*do\b/],    // block form auto-closes
};

// ── Auto-restart / self-respawn patterns ──

export const AUTO_RESTART_PATTERNS: Record<string, RegExp[]> = {
    js: [
        /process\.on\s*\(\s*['"](?:exit|uncaughtException|SIGTERM)['"]\s*,\s*(?:function|\(|=>).*(?:spawn|exec|fork)/,
        /process\.on\s*\(\s*['"]exit['"]/,
    ],
    ts: [
        /process\.on\s*\(\s*['"](?:exit|uncaughtException|SIGTERM)['"]\s*,\s*(?:function|\(|=>).*(?:spawn|exec|fork)/,
        /process\.on\s*\(\s*['"]exit['"]/,
    ],
    py: [
        /\batexit\.register\s*\(/,
        /\bsignal\.signal\s*\(\s*signal\.SIG\w+\s*,/,
    ],
    go: [
        /\bsignal\.Notify\s*\(/,
        /\bos\.Exit\s*\(/,
    ],
    java: [
        /\bRuntime\.getRuntime\(\)\.addShutdownHook\b/,
    ],
    rs: [
        /\bctrlc::set_handler\b/,
        /\bsignal::ctrl_c\b/,
    ],
    cs: [
        /\bAppDomain\.CurrentDomain\.ProcessExit\b/,
    ],
    rb: [
        /\bat_exit\b/,
        /\btrap\s*\(/,
    ],
};
