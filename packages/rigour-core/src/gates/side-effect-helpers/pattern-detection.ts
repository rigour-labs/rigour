import { SideEffectLang, stripStrings } from './types.js';

// ═══════════════════════════════════════════════════════════════════
// CIRCULAR TRIGGER DETECTION — Path overlap analysis
// ═══════════════════════════════════════════════════════════════════

/**
 * Extract the path being watched from a file watcher call.
 * Returns null if path cannot be determined.
 *
 * Handles:
 * - fs.watch('./src', ...)
 * - chokidar.watch(['./src', './lib'], ...)
 * - Observer(path=...)
 * - fsnotify.NewWatcher() + watcher.Add(path)
 */
export function extractWatchedPath(line: string): string | null {
    // String literal path
    const stringMatch = line.match(/(?:watch|Watch|observe|Add)\s*\(\s*['"]([^'"]+)['"]/);
    if (stringMatch) return stringMatch[1];

    // Variable path (best effort — capture the variable name)
    const varMatch = line.match(/(?:watch|Watch|observe|Add)\s*\(\s*(\w+)/);
    if (varMatch) return `$${varMatch[1]}`;  // Mark as variable reference

    return null;
}

/**
 * Extract write target path from a file write call.
 * Returns null if path cannot be determined.
 */
export function extractWritePath(line: string): string | null {
    // writeFile/writeFileSync('path', ...) or similar
    const stringMatch = line.match(/(?:writeFile|appendFile|Write|Create|open)\s*(?:Sync)?\s*\(\s*['"]([^'"]+)['"]/);
    if (stringMatch) return stringMatch[1];

    // Variable path
    const varMatch = line.match(/(?:writeFile|appendFile|Write|Create)\s*(?:Sync)?\s*\(\s*(\w+)/);
    if (varMatch) return `$${varMatch[1]}`;

    return null;
}

/**
 * Check if a write path could trigger a file watcher.
 *
 * Smart matching:
 * - "./src/output.js" is inside watched "./src"
 * - "./dist/bundle.js" is NOT inside "./src"
 * - If either path is a variable reference ($var), consider it suspicious
 * - Exact matches always overlap
 */
export function pathsOverlap(watchPath: string | null, writePath: string | null): boolean {
    if (!watchPath || !writePath) return false;

    // If either is a variable reference, we can't determine — be conservative
    if (watchPath.startsWith('$') || writePath.startsWith('$')) return true;

    // Normalize paths
    const normalizeP = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
    const w = normalizeP(watchPath);
    const t = normalizeP(writePath);

    // Exact match
    if (w === t) return true;

    // Write target is inside watched directory
    if (t.startsWith(w + '/')) return true;

    // Watch target is inside write directory (writing a parent dir)
    if (w.startsWith(t + '/')) return true;

    return false;
}


// ═══════════════════════════════════════════════════════════════════
// LOOP & RECURSION ANALYSIS — Context-aware body extraction
// ═══════════════════════════════════════════════════════════════════

import { findBlockEndBrace, findBlockEndIndent } from './scope-analysis.js';

/**
 * Extract loop body with correct scope tracking.
 * Uses brace/indent matching (not just "next N lines").
 */
export function extractLoopBody(
    lines: string[], loopLine: number, lang: SideEffectLang,
): { body: string; start: number; end: number } {
    const end = lang === 'py'
        ? findBlockEndIndent(lines, loopLine)
        : lang === 'rb'
            ? findBlockEndRuby(lines, loopLine)
            : findBlockEndBrace(lines, loopLine);

    const body = lines.slice(loopLine, end).join('\n');
    return { body, start: loopLine, end };
}

function findBlockEndRuby(lines: string[], start: number): number {
    let depth = 0;
    const maxScan = Math.min(lines.length, start + 300);
    const openers = /\b(?:def|do|class|module|if|unless|while|until|for|begin|case)\b/;
    for (let j = start; j < maxScan; j++) {
        const trimmed = lines[j].trim();
        if (openers.test(trimmed)) depth++;
        if (/^\s*end\b/.test(trimmed)) {
            depth--;
            if (depth <= 0) return j + 1;
        }
    }
    return maxScan;
}

/**
 * Extract all function definitions with their bodies.
 * Used for recursion detection — need to check if function calls itself
 * within its own extracted body (not just anywhere in the file).
 */
export function extractFunctionDefs(
    lines: string[], lang: SideEffectLang,
): { name: string; start: number; end: number; params: string }[] {
    const defs: { name: string; start: number; end: number; params: string }[] = [];
    const patterns = getFuncDefPatterns(lang);

    for (let i = 0; i < lines.length; i++) {
        const stripped = stripStrings(lines[i]);
        for (const pat of patterns) {
            const m = pat.exec(stripped);
            if (!m) continue;
            const name = m[1];
            if (!name || ['if', 'for', 'while', 'switch', 'catch', 'else'].includes(name)) continue;

            const end = lang === 'py'
                ? findBlockEndIndent(lines, i)
                : lang === 'rb'
                    ? findBlockEndRuby(lines, i)
                    : findBlockEndBrace(lines, i);

            defs.push({ name, start: i, end, params: lines[i] });
            break;
        }
    }
    return defs;
}

function getFuncDefPatterns(lang: SideEffectLang): RegExp[] {
    switch (lang) {
        case 'py': return [/^\s*(?:async\s+)?def\s+(\w+)\s*\(/];
        case 'go': return [/^func\s+(?:\([^)]+\)\s+)?(\w+)\s*\(/];
        case 'rb': return [/^\s*def\s+(\w+)/];
        case 'rs': return [/\bfn\s+(\w+)\s*[(<]/];
        case 'java':
        case 'cs':
            return [/(?:public|private|protected|static|async|void|int|string|Task|var|String|boolean|List|Map)\s+(\w+)\s*\(/];
        default: // js, ts
            return [
                /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/,
                /(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|\w+)\s*=>/,
            ];
    }
}

/**
 * Check if a function has a base case (return/break before recursive call).
 * Smart: actually checks that the base case comes BEFORE the recursive call,
 * not just that both exist somewhere in the body.
 */
export function hasBaseCase(
    bodyLines: string[], funcName: string,
): boolean {
    const escapedName = funcName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const selfCallPat = new RegExp(`\\b${escapedName}\\s*\\(`);

    let foundBaseReturn = false;

    for (const line of bodyLines) {
        const stripped = stripStrings(line);
        // Check for conditional return/break (base case)
        if (/\bif\b.*\b(?:return|break)\b/.test(stripped) ||
            /\b(?:return|break)\b.*\bif\b/.test(stripped)) {
            foundBaseReturn = true;
        }
        // Guard clauses: `if (x) return;` at start of function
        if (/^\s*if\s*\(.*\)\s*(?:return|break)\b/.test(stripped)) {
            foundBaseReturn = true;
        }
        // Check for self-call
        if (selfCallPat.test(stripped)) {
            // If we found a base case before the recursive call, it's bounded
            if (foundBaseReturn) return true;
        }
    }

    // Also check for depth/level parameters which imply bounded recursion
    return false;
}

/**
 * Check if a function has a depth/limit parameter (implies bounded recursion).
 * Smarter than just checking for the word "depth" anywhere — checks the
 * function signature specifically.
 */
export function hasDepthParameter(funcLine: string): boolean {
    const paramMatch = funcLine.match(/\(([^)]*)\)/);
    if (!paramMatch) return false;
    const params = paramMatch[1].toLowerCase();
    return /\b(?:depth|level|max_depth|maxdepth|max_level|maxlevel|limit|max_retries|maxretries|remaining|budget)\b/.test(params);
}


// ═══════════════════════════════════════════════════════════════════
// I/O DETECTION — Check if code performs I/O (makes loops dangerous)
// ═══════════════════════════════════════════════════════════════════

/**
 * Check if a code block contains I/O operations.
 * Language-aware: knows which stdlib calls are I/O.
 */
export function containsIO(body: string, lang: SideEffectLang): boolean {
    const patterns = getIOPatterns(lang);
    const stripped = body.split('\n').map(l => stripStrings(l)).join('\n');
    return patterns.some(pat => pat.test(stripped));
}

function getIOPatterns(lang: SideEffectLang): RegExp[] {
    switch (lang) {
        case 'js':
        case 'ts':
            return [
                /\bfs\.\w+/, /\bfetch\s*\(/, /\baxios\.\w+/, /\bhttp\.\w+/,
                /\.write\s*\(/, /\.send\s*\(/, /\bchild_process\./,
                /\bprocess\.stdout/, /\bnet\.\w+/,
            ];
        case 'py':
            return [
                /\bopen\s*\(/, /\brequests\.\w+/, /\burllib\.\w+/,
                /\bsubprocess\./, /\bos\.\w+/, /\bsocket\.\w+/,
                /\.write\s*\(/, /\bprint\s*\(/,
            ];
        case 'go':
            return [
                /\bos\.\w+/, /\bnet\.\w+/, /\bhttp\.\w+/,
                /\bio\.\w+/, /\bfmt\.Fprint/, /\bexec\.Command/,
            ];
        case 'java':
            return [
                /\bnew\s+File\w*\(/, /\bHttpClient\b/, /\bSocket\b/,
                /\.write\s*\(/, /\bRuntime\.getRuntime\(\)/,
            ];
        case 'rs':
            return [
                /\bstd::fs::/, /\bstd::net::/, /\bstd::process::/,
                /\.write\s*\(/, /\btokio::\w+/,
            ];
        case 'cs':
            return [
                /\bFile\.\w+/, /\bHttpClient\b/, /\bProcess\.Start/,
                /\.Write\s*\(/, /\bSocket\b/,
            ];
        case 'rb':
            return [
                /\bFile\.\w+/, /\bNet::HTTP\b/, /\bIO\.\w+/,
                /\.write\s*\(/, /\bsystem\s*\(/,
            ];
        default:
            return [];
    }
}


// ═══════════════════════════════════════════════════════════════════
// RETRY/CIRCUIT BREAKER — Smart limit detection
// ═══════════════════════════════════════════════════════════════════

/**
 * Check if a loop body or its preamble contains a retry limit.
 *
 * Smart: checks variable declarations before the loop AND inside the loop.
 * Recognizes both explicit counters and library patterns.
 */
export function hasRetryLimit(
    lines: string[], loopLine: number, bodyEnd: number,
): boolean {
    // Check preamble (10 lines before loop) for counter declarations
    const preambleStart = Math.max(0, loopLine - 10);
    const preamble = lines.slice(preambleStart, loopLine).join('\n');

    // Check body for limit patterns
    const body = lines.slice(loopLine, bodyEnd).join('\n');
    const combined = preamble + '\n' + body;

    return RETRY_LIMIT_PATTERNS.some(pat => pat.test(combined));
}

const RETRY_LIMIT_PATTERNS: RegExp[] = [
    /max.?retries?\s*[=:]/i,
    /retry.?(?:count|limit)\s*[=:]/i,
    /\battempt(?:s)?\s*[<>=!]+\s*\d+/i,
    /\bretries?\s*[<>=!]+\s*\d+/i,
    /\bcount\s*[<>=!]+\s*\d+.*\bbreak\b/i,
    /\bMAX_/,
    /\bbackoff\b/i,
    /\bcircuit.?breaker\b/i,
    /\bfor\s+\w+\s*(?::=|=|in\s+range)\s*\d+/,  // for i = 0; i < N (bounded)
    /\bfor\s+\w+\s+in\s+range\s*\(\s*\d+/,       // Python: for i in range(N)
    /\.retries?\s*\(\s*\d+\s*\)/,                  // library: .retry(3)
    /\bretry\s*\(\s*\d+\s*\)/,
];

/**
 * Check if error handling inside a loop constitutes a retry pattern.
 * Not just "catch exists" but "catch is followed by continue or the loop wraps the try".
 */
export function hasCatchWithContinue(body: string, lang: SideEffectLang): boolean {
    if (lang === 'py') {
        // Python: except ... followed by continue or pass
        return /\bexcept\b[^:]*:[\s\S]*?\b(?:continue|pass)\b/.test(body);
    }
    if (lang === 'go') {
        // Go: if err != nil { continue } or { log; continue }
        return /\bif\s+err\s*!=\s*nil\b[\s\S]*?\bcontinue\b/.test(body);
    }
    if (lang === 'rb') {
        return /\brescue\b[\s\S]*?\b(?:retry|next)\b/.test(body);
    }
    // JS/TS/Java/C#: catch { ... continue }
    return /\bcatch\b[\s\S]*?\bcontinue\b/.test(body);
}


// ═══════════════════════════════════════════════════════════════════
// PROCESS & TIMER OPERATIONS
// ═══════════════════════════════════════════════════════════════════

/**
 * Check if a line contains a process spawn call.
 */
export function isProcessSpawn(line: string, lang: SideEffectLang): RegExpMatchArray | null {
    const stripped = stripStrings(line);
    const patterns = getSpawnPatterns(lang);
    for (const pat of patterns) {
        const m = pat.exec(stripped);
        if (m) return m;
    }
    return null;
}

function getSpawnPatterns(lang: SideEffectLang): RegExp[] {
    switch (lang) {
        case 'js':
        case 'ts':
            return [
                /\b(?:spawn|exec|execFile|fork|execa)\s*\(/,
                /\bchild_process\.\w+\s*\(/,
            ];
        case 'py':
            return [
                /\bsubprocess\.(?:Popen|run|call|check_output|check_call)\s*\(/,
                /\bos\.(?:system|exec\w*|spawn\w*)\s*\(/,
            ];
        case 'go':
            return [/\bexec\.Command\s*\(/, /\bcmd\.(?:Start|Run)\s*\(/];
        case 'java':
            return [/\bProcessBuilder\b/, /\bRuntime\.getRuntime\(\)\.exec\s*\(/];
        case 'rs':
            return [/\bCommand::new\s*\(/];
        case 'cs':
            return [/\bProcess\.Start\s*\(/];
        case 'rb':
            return [/\bsystem\s*\(/, /\bIO\.popen\s*\(/, /\bspawn\s*\(/];
        default:
            return [];
    }
}

/**
 * Check if a line contains a timer creation call.
 * Returns the timer function name if matched.
 */
export function isTimerCreation(line: string, lang: SideEffectLang): string | null {
    const stripped = stripStrings(line);
    const patterns = getTimerCreatePatterns(lang);
    for (const [pat, name] of patterns) {
        if (pat.test(stripped)) return name;
    }
    return null;
}

function getTimerCreatePatterns(lang: SideEffectLang): [RegExp, string][] {
    switch (lang) {
        case 'js':
        case 'ts':
            return [
                [/\bsetInterval\s*\(/, 'setInterval'],
                [/\bsetTimeout\s*\(/, 'setTimeout'],
            ];
        case 'py':
            return [
                [/\bTimer\s*\(/, 'Timer'],
                [/\bscheduler\.enter\s*\(/, 'scheduler.enter'],
                [/\bschedule\.every\b/, 'schedule.every'],
            ];
        case 'go':
            return [
                [/\btime\.NewTicker\s*\(/, 'NewTicker'],
                [/\btime\.Tick\s*\(/, 'Tick'],
            ];
        case 'java':
            return [
                [/\bScheduledExecutorService\b/, 'ScheduledExecutorService'],
                [/\bTimer\(\)\.schedule/, 'Timer.schedule'],
            ];
        case 'cs':
            return [
                [/\bnew\s+Timer\s*\(/, 'Timer'],
            ];
        default:
            return [];
    }
}

/**
 * Get cleanup patterns for timers (language-specific).
 */
export function getTimerCleanupPatterns(lang: SideEffectLang): RegExp[] {
    switch (lang) {
        case 'js':
        case 'ts':
            return [/\bclearInterval\s*\(/, /\bclearTimeout\s*\(/];
        case 'py':
            return [/\.cancel\s*\(/];
        case 'go':
            return [/\.Stop\s*\(/];
        case 'java':
            return [/\.shutdown\s*\(/, /\.cancel\s*\(/];
        case 'cs':
            return [/\.Dispose\s*\(/, /\.Stop\s*\(/];
        default:
            return [];
    }
}

/**
 * Get cleanup patterns for spawned processes.
 */
export function getProcessCleanupPatterns(lang: SideEffectLang): RegExp[] {
    switch (lang) {
        case 'js':
        case 'ts':
            return [
                /\.on\s*\(\s*['"](?:exit|close)['"]/,
                /\.kill\s*\(/,
                /\.disconnect\s*\(/,
            ];
        case 'py':
            return [/\.wait\s*\(/, /\.terminate\s*\(/, /\.kill\s*\(/, /\.communicate\s*\(/];
        case 'go':
            return [/\.Wait\s*\(/, /\.Process\.Kill\s*\(/];
        case 'java':
            return [/\.waitFor\s*\(/, /\.destroy\s*\(/];
        case 'rs':
            return [/\.wait\s*\(/, /\.kill\s*\(/];
        case 'cs':
            return [/\.WaitForExit\s*\(/, /\.Kill\s*\(/];
        case 'rb':
            return [/Process\.wait\b/, /Process\.kill\b/];
        default:
            return [];
    }
}


// ═══════════════════════════════════════════════════════════════════
// LOOP PATTERNS & RESOURCE DETECTION
// ═══════════════════════════════════════════════════════════════════

/**
 * Check if a line contains an unbounded loop construct.
 */
export function isUnboundedLoop(line: string, lang: SideEffectLang): boolean {
    const stripped = stripStrings(line);
    const patterns = getUnboundedLoopPatterns(lang);
    return patterns.some(p => p.test(stripped));
}

function getUnboundedLoopPatterns(lang: SideEffectLang): RegExp[] {
    switch (lang) {
        case 'js':
        case 'ts':
            return [/\bwhile\s*\(\s*true\s*\)/, /\bwhile\s*\(\s*1\s*\)/, /\bfor\s*\(\s*;\s*;\s*\)/];
        case 'py':
            return [/\bwhile\s+True\s*:/, /\bwhile\s+1\s*:/];
        case 'go':
            return [/\bfor\s*\{/];
        case 'java':
        case 'cs':
            return [/\bwhile\s*\(\s*true\s*\)/, /\bfor\s*\(\s*;\s*;\s*\)/];
        case 'rs':
            return [/\bloop\s*\{/];
        case 'rb':
            return [/\bloop\s+do\b/, /\bwhile\s+true\b/];
        default:
            return [];
    }
}

/**
 * Check if a line creates a file watcher.
 * Returns the watcher function name if matched.
 */
export function isFileWatcher(line: string, lang: SideEffectLang): string | null {
    const stripped = stripStrings(line);
    const patterns = getWatcherPatterns(lang);
    for (const [pat, name] of patterns) {
        if (pat.test(stripped)) return name;
    }
    return null;
}

function getWatcherPatterns(lang: SideEffectLang): [RegExp, string][] {
    switch (lang) {
        case 'js':
        case 'ts':
            return [
                [/\bfs\.watch\s*\(/, 'fs.watch'],
                [/\bfs\.watchFile\s*\(/, 'fs.watchFile'],
                [/\bchokidar\.watch\s*\(/, 'chokidar.watch'],
                [/\bnew\s+FSWatcher\b/, 'FSWatcher'],
            ];
        case 'py':
            return [
                [/\bObserver\s*\(/, 'Observer'],
                [/\binotify\b/, 'inotify'],
                [/\bwatchfiles\b/, 'watchfiles'],
            ];
        case 'go':
            return [
                [/\bfsnotify\.\w+/, 'fsnotify'],
                [/\bNewWatcher\s*\(/, 'NewWatcher'],
            ];
        case 'java':
            return [[/\bWatchService\b/, 'WatchService']];
        case 'cs':
            return [[/\bnew\s+FileSystemWatcher\b/, 'FileSystemWatcher']];
        case 'rb':
            return [[/\bListen\.\w+/, 'Listen']];
        default:
            return [];
    }
}

/**
 * Check if a code body contains file write operations.
 * Returns the first write call found, or null.
 */
export function findWriteInBody(body: string, lang: SideEffectLang): string | null {
    const patterns = getWritePatterns(lang);
    for (const pat of patterns) {
        const m = pat.exec(body);
        if (m) return m[0];
    }
    return null;
}

function getWritePatterns(lang: SideEffectLang): RegExp[] {
    switch (lang) {
        case 'js':
        case 'ts':
            return [/\bfs\.writeFile\w*/, /\bfs\.appendFile\w*/, /\bfs\.createWriteStream/];
        case 'py':
            return [/\bopen\s*\([^)]*['"][wa]['"]/, /\bshutil\.\w+/];
        case 'go':
            return [/\bos\.WriteFile/, /\bos\.Create/, /\bio\.WriteString/];
        case 'java':
            return [/\bFileWriter\b/, /\bBufferedWriter\b/];
        case 'rs':
            return [/\bfs::write/, /\bFile::create/];
        case 'cs':
            return [/\bFile\.Write\w*/, /\bStreamWriter\b/];
        case 'rb':
            return [/\bFile\.write/, /\bFile\.open\s*\([^)]*['"]w['"]/];
        default:
            return [];
    }
}

/**
 * Check if a file watcher callback has debounce/throttle protection.
 */
export function hasDebounceProtection(body: string): boolean {
    return /\b(?:debounce|throttle|\.once\s*\(|ignore_self|ignoreInitial|_isProcessing|_skipNext|lock|mutex|semaphore)\b/i.test(body);
}

/**
 * Get resource open patterns for lifecycle checking.
 */
export function isResourceOpen(line: string, lang: SideEffectLang): string | null {
    const stripped = stripStrings(line);
    const patterns = getResourceOpenPatterns(lang);
    for (const [pat, name] of patterns) {
        if (pat.test(stripped)) return name;
    }
    return null;
}

function getResourceOpenPatterns(lang: SideEffectLang): [RegExp, string][] {
    switch (lang) {
        case 'js':
        case 'ts':
            return [
                [/\bfs\.open\s*\(/, 'fs.open'],
                [/\bfs\.createReadStream\s*\(/, 'createReadStream'],
                [/\bfs\.createWriteStream\s*\(/, 'createWriteStream'],
            ];
        case 'py':
            return [[/\bopen\s*\(/, 'open']];
        case 'go':
            return [
                [/\bos\.Open\s*\(/, 'os.Open'],
                [/\bos\.Create\s*\(/, 'os.Create'],
                [/\bos\.OpenFile\s*\(/, 'os.OpenFile'],
            ];
        case 'java':
            return [
                [/\bnew\s+FileInputStream\b/, 'FileInputStream'],
                [/\bnew\s+FileOutputStream\b/, 'FileOutputStream'],
                [/\bnew\s+BufferedReader\b/, 'BufferedReader'],
            ];
        case 'rs':
            return [
                [/\bFile::open\s*\(/, 'File::open'],
                [/\bFile::create\s*\(/, 'File::create'],
            ];
        case 'cs':
            return [
                [/\bFile\.Open\s*\(/, 'File.Open'],
                [/\bnew\s+FileStream\b/, 'FileStream'],
                [/\bnew\s+StreamReader\b/, 'StreamReader'],
            ];
        case 'rb':
            return [[/\bFile\.open\s*\(/, 'File.open']];
        default:
            return [];
    }
}

/**
 * Get resource close patterns.
 */
export function getResourceClosePatterns(lang: SideEffectLang): RegExp[] {
    switch (lang) {
        case 'js':
        case 'ts':
            return [/\.close\s*\(/, /\.destroy\s*\(/, /\.end\s*\(/];
        case 'py':
            return [/\.close\s*\(/];
        case 'go':
            return [/\.Close\s*\(/];
        case 'java':
            return [/\.close\s*\(/];
        case 'rs':
            return [/\bdrop\s*\(/];
        case 'cs':
            return [/\.Close\s*\(/, /\.Dispose\s*\(/];
        case 'rb':
            return [/\.close\b/];
        default:
            return [];
    }
}

/**
 * Check if an exit/signal handler respawns the process (auto-restart pattern).
 */
export function isExitHandler(line: string, lang: SideEffectLang): boolean {
    const stripped = stripStrings(line);
    switch (lang) {
        case 'js':
        case 'ts':
            return /process\.on\s*\(\s*['"](?:exit|uncaughtException|SIGTERM|SIGINT)['"]/.test(stripped);
        case 'py':
            return /\batexit\.register\s*\(/.test(stripped) ||
                /\bsignal\.signal\s*\(\s*signal\.SIG\w+/.test(stripped);
        case 'go':
            return /\bsignal\.Notify\s*\(/.test(stripped);
        case 'java':
            return /\bRuntime\.getRuntime\(\)\.addShutdownHook\b/.test(stripped);
        case 'cs':
            return /\bAppDomain\.CurrentDomain\.ProcessExit\b/.test(stripped);
        case 'rb':
            return /\bat_exit\b/.test(stripped) || /\btrap\s*\(/.test(stripped);
        case 'rs':
            return /\bctrlc::set_handler\b/.test(stripped) ||
                /\bsignal::ctrl_c\b/.test(stripped);
        default:
            return false;
    }
}
