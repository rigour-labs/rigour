/**
 * Side-Effect Analysis Gate
 *
 * Context-aware detection of code patterns with real-world consequences:
 * unbounded process spawns, runaway timers, missing circuit breakers,
 * circular file watchers, resource leaks, and auto-restart bombs.
 *
 * SMART DETECTION APPROACH (not hardcoded regex):
 * ───────────────────────────────────────────────
 * 1. VARIABLE BINDING TRACKING: Tracks `const id = setInterval(...)` and
 *    verifies `clearInterval(id)` exists — not just "does clearInterval
 *    appear somewhere in the file?"
 *
 * 2. SCOPE-AWARE ANALYSIS: Checks cleanup is in the same function scope
 *    as creation. A clearInterval in a completely different function doesn't
 *    help the one that created the timer.
 *
 * 3. FRAMEWORK AWARENESS: Understands React useEffect cleanup returns,
 *    Go `defer f.Close()` idiom, Python `with open()` context managers,
 *    Java try-with-resources, C# using statements, Ruby block form.
 *
 * 4. PATH OVERLAP ANALYSIS: For circular triggers, extracts actual paths
 *    from watch() and writeFile() calls and checks if they overlap.
 *
 * 5. BASE CASE ORDERING: For recursion, checks that the base case
 *    (return/break) comes BEFORE the recursive call, not just that
 *    both exist somewhere in the function.
 *
 * Follows the architectural patterns of:
 * - hallucinated-imports (build context → scan → resolve → report)
 * - promise-safety (scope-aware helpers, extractBraceBody, isInsideTryBlock)
 *
 * This is a CORE gate (enabled by default, provenance: ai-drift).
 * Supports: JS/TS, Python, Go, Rust, C#, Java, Ruby
 *
 * @since v4.3.0
 */

import { Gate, GateContext } from './base.js';
import { Failure, Provenance } from '../types/index.js';
import { FileScanner } from '../utils/scanner.js';
import { Logger } from '../utils/logger.js';
import fs from 'fs-extra';
import path from 'path';

import {
    SideEffectLang,
    SideEffectViolation,
    ResourceBinding,
    LANG_MAP,
    FILE_GLOBS,
    stripStrings,
    // Scope analysis
    findEnclosingFunction,
    findBlockEndBrace,
    findBlockEndIndent,
    extractLoopBody,
    extractFunctionDefs,
    // Variable binding
    extractVariableBinding,
    hasCleanupForVariable,
    // Framework awareness
    isInUseEffectWithCleanup,
    hasGoDefer,
    isPythonWithStatement,
    isJavaTryWithResources,
    isCSharpUsing,
    isRubyBlockForm,
    isRustAutoDropped,
    isInsideCleanupContext,
    // Detectors
    isTimerCreation,
    getTimerCleanupPatterns,
    isProcessSpawn,
    getProcessCleanupPatterns,
    isUnboundedLoop,
    containsIO,
    isFileWatcher,
    extractWatchedPath,
    extractWritePath,
    pathsOverlap,
    findWriteInBody,
    hasDebounceProtection,
    isResourceOpen,
    getResourceClosePatterns,
    isExitHandler,
    // Loop/recursion
    hasRetryLimit,
    hasCatchWithContinue,
    hasBaseCase,
    hasDepthParameter,
} from './side-effect-helpers.js';

export interface SideEffectAnalysisConfig {
    enabled?: boolean;
    check_unbounded_timers?: boolean;
    check_unbounded_loops?: boolean;
    check_process_lifecycle?: boolean;
    check_recursive_depth?: boolean;
    check_resource_lifecycle?: boolean;
    check_retry_without_limit?: boolean;
    check_circular_triggers?: boolean;
    check_auto_restart?: boolean;
    ignore_patterns?: string[];
}

export class SideEffectAnalysisGate extends Gate {
    private cfg: Required<Omit<SideEffectAnalysisConfig, 'ignore_patterns'>> & { ignore_patterns: string[] };

    constructor(config: SideEffectAnalysisConfig = {}) {
        super('side-effect-analysis', 'Side-Effect Safety Analysis');
        this.cfg = {
            enabled: config.enabled ?? true,
            check_unbounded_timers: config.check_unbounded_timers ?? true,
            check_unbounded_loops: config.check_unbounded_loops ?? true,
            check_process_lifecycle: config.check_process_lifecycle ?? true,
            check_recursive_depth: config.check_recursive_depth ?? true,
            check_resource_lifecycle: config.check_resource_lifecycle ?? true,
            check_retry_without_limit: config.check_retry_without_limit ?? true,
            check_circular_triggers: config.check_circular_triggers ?? true,
            check_auto_restart: config.check_auto_restart ?? true,
            ignore_patterns: config.ignore_patterns ?? [],
        };
    }

    protected get provenance(): Provenance { return 'ai-drift'; }

    async run(context: GateContext): Promise<Failure[]> {
        if (!this.cfg.enabled) return [];

        const violations: SideEffectViolation[] = [];
        const files = await FileScanner.findFiles({
            cwd: context.cwd,
            patterns: FILE_GLOBS,
            ignore: [
                ...(context.ignore || []),
                '**/node_modules/**', '**/dist/**', '**/build/**',
                '**/*.test.*', '**/*.spec.*', '**/__tests__/**',
                '**/vendor/**', '**/__pycache__/**', '**/venv/**', '**/.venv/**',
                '**/bin/Debug/**', '**/bin/Release/**', '**/obj/**',
                '**/target/debug/**', '**/target/release/**',
            ],
        });

        Logger.info(`Side-Effect Analysis: Scanning ${files.length} files`);

        for (const file of files) {
            if (this.cfg.ignore_patterns.some(p => new RegExp(p).test(file))) continue;

            const ext = path.extname(file).toLowerCase();
            const lang = LANG_MAP[ext];
            if (!lang) continue;

            try {
                const fullPath = path.join(context.cwd, file);
                const content = await fs.readFile(fullPath, 'utf-8');
                const lines = content.split('\n');

                this.scanFile(lang, lines, content, file, violations);
            } catch { /* skip unreadable files */ }
        }

        return this.buildFailures(violations);
    }

    private scanFile(
        lang: SideEffectLang, lines: string[], content: string,
        file: string, violations: SideEffectViolation[],
    ): void {
        if (this.cfg.check_unbounded_timers) {
            this.checkUnboundedTimers(lang, lines, file, violations);
        }
        if (this.cfg.check_process_lifecycle) {
            this.checkProcessLifecycle(lang, lines, file, violations);
        }
        if (this.cfg.check_unbounded_loops) {
            this.checkUnboundedLoops(lang, lines, file, violations);
        }
        if (this.cfg.check_retry_without_limit) {
            this.checkRetryWithoutLimit(lang, lines, file, violations);
        }
        if (this.cfg.check_circular_triggers) {
            this.checkCircularTriggers(lang, lines, file, violations);
        }
        if (this.cfg.check_resource_lifecycle) {
            this.checkResourceLifecycle(lang, lines, file, violations);
        }
        if (this.cfg.check_recursive_depth) {
            this.checkRecursiveDepth(lang, lines, file, violations);
        }
        if (this.cfg.check_auto_restart) {
            this.checkAutoRestart(lang, lines, file, violations);
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // CHECK 1: Unbounded Timers
    //
    // SMART: Tracks the variable binding. Instead of "does clearInterval
    // exist in the file?", checks "is the timer variable cleaned up in
    // the same scope, or in a React useEffect cleanup return?"
    // ═══════════════════════════════════════════════════════════════

    private checkUnboundedTimers(
        lang: SideEffectLang, lines: string[],
        file: string, violations: SideEffectViolation[],
    ): void {
        const cleanupPats = getTimerCleanupPatterns(lang);
        if (cleanupPats.length === 0) return;  // Language has no timer API

        for (let i = 0; i < lines.length; i++) {
            const timerCall = isTimerCreation(lines[i], lang);
            if (!timerCall) continue;

            // Extract variable binding: `const timer = setInterval(...)`
            const varName = extractVariableBinding(lines[i], lang);

            // Find enclosing function scope
            const scope = findEnclosingFunction(lines, i, lang);

            // FRAMEWORK CHECK: React useEffect with cleanup return
            if ((lang === 'js' || lang === 'ts') && isInUseEffectWithCleanup(lines, i)) {
                continue;  // useEffect cleanup handles it
            }

            // FRAMEWORK CHECK: Inside a cleanup/teardown context already
            if (isInsideCleanupContext(lines, i, lang)) {
                continue;  // Timer in cleanup = intentional short-lived timer
            }

            if (varName) {
                // Variable is stored — check for cleanup using that specific variable
                const hasPairedCleanup = hasCleanupForVariable(
                    lines, varName, scope.start, scope.end, cleanupPats, lang,
                );
                if (hasPairedCleanup) continue;  // Properly paired
            } else {
                // Fire-and-forget timer (no variable binding) — most dangerous
                // But check if there's ANY cleanup in the same scope (lenient)
                const scopeBody = lines.slice(scope.start, scope.end).join('\n');
                if (cleanupPats.some(cp => cp.test(scopeBody))) continue;
            }

            violations.push({
                rule: 'unbounded-timer',
                severity: 'high',
                file, line: i + 1,
                match: lines[i].trim().substring(0, 100),
                description: varName
                    ? `Timer '${varName} = ${timerCall}(...)' created but ` +
                      `'${varName}' is never passed to a cleanup function ` +
                      `(${cleanupPats.map(p => p.source.match(/\w+/)?.[0]).filter(Boolean).join('/')}) ` +
                      `in the same scope.`
                    : `${timerCall}() called without storing the return value. ` +
                      `The timer runs indefinitely with no way to stop it.`,
                hint: varName
                    ? `Call cleanup with the specific variable: e.g. clearInterval(${varName})`
                    : `Store the timer: const id = ${timerCall}(...); then clear it in cleanup.`,
            });
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // CHECK 2: Process Lifecycle (orphan processes)
    //
    // SMART: Tracks the spawned process variable. Checks that the
    // specific process has exit handling, .wait(), or .kill() — not
    // just that these words appear somewhere nearby.
    // ═══════════════════════════════════════════════════════════════

    private checkProcessLifecycle(
        lang: SideEffectLang, lines: string[],
        file: string, violations: SideEffectViolation[],
    ): void {
        const cleanupPats = getProcessCleanupPatterns(lang);

        for (let i = 0; i < lines.length; i++) {
            const spawnMatch = isProcessSpawn(lines[i], lang);
            if (!spawnMatch) continue;

            const varName = extractVariableBinding(lines[i], lang);
            const scope = findEnclosingFunction(lines, i, lang);

            // Check if the process result is awaited on the same line
            if (/\bawait\b/.test(lines[i])) continue;

            // Check if the process is returned (caller handles lifecycle)
            const nextLines = lines.slice(i, Math.min(lines.length, i + 3)).join(' ');
            if (/\breturn\b/.test(nextLines)) continue;

            // Go: check for deferred cleanup
            if (lang === 'go' && varName && hasGoDefer(lines, i, varName)) continue;

            // Python subprocess.run() and check_output() are synchronous — safe
            if (lang === 'py' && /\.(?:run|check_output|check_call)\s*\(/.test(lines[i])) continue;

            // Rust Command::new().output() is synchronous
            if (lang === 'rs' && /\.output\s*\(\)/.test(lines.slice(i, i + 2).join(' '))) continue;

            if (varName) {
                // Check for cleanup on the specific process variable
                const hasPairedCleanup = hasCleanupForVariable(
                    lines, varName, scope.start, scope.end, cleanupPats, lang,
                );
                if (hasPairedCleanup) continue;
            } else {
                // Process not stored — check if synchronous call (exec is often sync)
                if (lang === 'py' && /\bos\.system\s*\(/.test(lines[i])) continue;
                if ((lang === 'js' || lang === 'ts') && /\bexecSync\s*\(/.test(lines[i])) continue;
            }

            violations.push({
                rule: 'orphan-process',
                severity: 'high',
                file, line: i + 1,
                match: lines[i].trim().substring(0, 100),
                description: varName
                    ? `Process '${varName}' spawned but no exit/cleanup handling found ` +
                      `for '${varName}' in the same scope. If the process hangs, it becomes ` +
                      `an orphan consuming resources.`
                    : `Process spawned without storing handle. No way to monitor or kill it.`,
                hint: lang === 'py'
                    ? `Add '${varName || 'proc'}.wait()' or use 'with' context manager.`
                    : lang === 'go'
                        ? `Add 'defer ${varName || 'cmd'}.Process.Kill()' or '${varName || 'cmd'}.Wait()'.`
                        : `Add '.on("exit", handler)' or '.kill()' in error path.`,
            });
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // CHECK 3: Unbounded Loops with I/O
    //
    // SMART: Extracts the actual loop body using scope-aware block
    // detection (brace/indent tracking), then checks for I/O ops
    // within that body specifically. Understands Go's `for { select {} }`
    // server pattern as safe.
    // ═══════════════════════════════════════════════════════════════

    private checkUnboundedLoops(
        lang: SideEffectLang, lines: string[],
        file: string, violations: SideEffectViolation[],
    ): void {
        for (let i = 0; i < lines.length; i++) {
            if (!isUnboundedLoop(lines[i], lang)) continue;

            // Extract actual loop body using scope tracking
            const { body, end } = extractLoopBody(lines, i, lang);

            // Check for I/O inside the extracted body
            if (!containsIO(body, lang)) continue;

            // Check for exit conditions within the body
            const hasBreak = /\b(?:break|return)\b/.test(body);
            const hasSleep = /\b(?:sleep|delay|setTimeout|time\.Sleep|asyncio\.sleep|Thread\.sleep|Task\.Delay)\b/i.test(body);

            // Go: `for { select {} }` is idiomatic server pattern
            if (lang === 'go' && /\bselect\s*\{/.test(body)) continue;

            // Go: `for { ... case <-ctx.Done(): return }` has context cancellation
            if (lang === 'go' && /ctx\.Done\(\)/.test(body)) continue;

            // Python: `while True: ... if condition: break` is common pattern
            if (hasBreak) continue;

            // Sleep/delay indicates intentional polling (not a tight spin loop)
            if (hasSleep) continue;

            violations.push({
                rule: 'unbounded-io-loop',
                severity: 'critical',
                file, line: i + 1,
                match: lines[i].trim().substring(0, 100),
                description: `Infinite loop with I/O operations and no exit condition or delay. ` +
                    `This will consume CPU and I/O resources indefinitely.`,
                hint: 'Add a break condition, max iteration count, or sleep/backoff between iterations.',
            });
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // CHECK 4: Retry Without Limit
    //
    // SMART: Looks for loops with catch/except that continue
    // (actual retry pattern), not just "catch exists in a loop".
    // Checks BOTH the loop body AND preamble (10 lines above)
    // for retry counter declarations.
    // ═══════════════════════════════════════════════════════════════

    private checkRetryWithoutLimit(
        lang: SideEffectLang, lines: string[],
        file: string, violations: SideEffectViolation[],
    ): void {
        for (let i = 0; i < lines.length; i++) {
            // We check both unbounded loops and while(condition) loops
            const stripped = stripStrings(lines[i]);
            const isLoop = isUnboundedLoop(lines[i], lang) || /\bwhile\s*\(/.test(stripped);
            if (!isLoop) continue;

            const { body, end } = extractLoopBody(lines, i, lang);

            // Check if this is actually a retry pattern (catch + continue)
            if (!hasCatchWithContinue(body, lang)) continue;

            // Check for retry limits in body AND preamble
            if (hasRetryLimit(lines, i, end)) continue;

            violations.push({
                rule: 'retry-without-limit',
                severity: 'high',
                file, line: i + 1,
                match: lines[i].trim().substring(0, 100),
                description: `Retry loop (catch + continue) without maximum attempt limit. ` +
                    `If the operation keeps failing, this retries indefinitely.`,
                hint: 'Add a maxRetries counter, exponential backoff, or circuit breaker pattern.',
            });
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // CHECK 5: Circular File Triggers (watch → write → watch → ...)
    //
    // SMART: Extracts the ACTUAL paths from watch() and writeFile()
    // calls, then checks if the write target is inside the watched
    // directory. Not just "write exists in watcher callback".
    // ═══════════════════════════════════════════════════════════════

    private checkCircularTriggers(
        lang: SideEffectLang, lines: string[],
        file: string, violations: SideEffectViolation[],
    ): void {
        for (let i = 0; i < lines.length; i++) {
            const watcherCall = isFileWatcher(lines[i], lang);
            if (!watcherCall) continue;

            // Extract the watched path
            const watchedPath = extractWatchedPath(lines[i]);

            // Extract the watcher callback body
            const { body, end } = extractLoopBody(lines, i, lang);

            // Check for file write operations in the callback body
            const writeCall = findWriteInBody(body, lang);
            if (!writeCall) continue;

            // Extract write target path and check overlap with watched path
            const bodyLines = body.split('\n');
            let writePath: string | null = null;
            for (const bl of bodyLines) {
                writePath = extractWritePath(bl);
                if (writePath) break;
            }

            // If we can determine paths, check if they overlap
            const definiteOverlap = pathsOverlap(watchedPath, writePath);

            // Even without path overlap detection, write inside a watch is suspicious
            // Check for debounce/throttle protection
            if (hasDebounceProtection(body)) continue;

            // If paths are known and don't overlap, skip
            if (watchedPath && writePath && !watchedPath.startsWith('$') &&
                !writePath.startsWith('$') && !definiteOverlap) {
                continue;
            }

            const pathInfo = watchedPath && !watchedPath.startsWith('$')
                ? ` on '${watchedPath}'`
                : '';
            const writeInfo = writePath && !writePath.startsWith('$')
                ? ` to '${writePath}'`
                : '';

            violations.push({
                rule: 'circular-trigger',
                severity: 'critical',
                file, line: i + 1,
                match: lines[i].trim().substring(0, 100),
                description: `File watcher${pathInfo} writes${writeInfo} in its callback ` +
                    `without debounce protection. ` +
                    (definiteOverlap
                        ? `The write target is inside the watched directory — this WILL create ` +
                          `an infinite trigger loop (watch → write → watch → ...).`
                        : `This risks an infinite trigger loop if the write target overlaps ` +
                          `with the watched path.`),
                hint: 'Add debouncing, a processing flag, or write to a path outside the watched directory.',
            });
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // CHECK 6: Resource Lifecycle (open without close)
    //
    // SMART: Uses variable binding to pair SPECIFIC open/close calls.
    // Understands language-specific safe patterns:
    //   Go: defer f.Close() (checks the specific variable)
    //   Python: with open() context manager
    //   Java: try-with-resources
    //   C#: using statement
    //   Ruby: block form
    //   Rust: RAII (auto-drop in safe code)
    // ═══════════════════════════════════════════════════════════════

    private checkResourceLifecycle(
        lang: SideEffectLang, lines: string[],
        file: string, violations: SideEffectViolation[],
    ): void {
        const closePats = getResourceClosePatterns(lang);

        for (let i = 0; i < lines.length; i++) {
            const resourceCall = isResourceOpen(lines[i], lang);
            if (!resourceCall) continue;

            // ── FRAMEWORK-AWARE SAFE PATTERN DETECTION ──

            // Python: `with open(...)` is safe
            if (lang === 'py' && isPythonWithStatement(lines[i])) continue;

            // Go: check for `defer varName.Close()` within 5 lines
            const varName = extractVariableBinding(lines[i], lang);
            if (lang === 'go' && varName && hasGoDefer(lines, i, varName)) continue;

            // Java: try-with-resources
            if (lang === 'java' && isJavaTryWithResources(lines, i)) continue;

            // C#: using statement
            if (lang === 'cs' && isCSharpUsing(lines[i])) continue;

            // Ruby: block form (auto-closes)
            if (lang === 'rb' && isRubyBlockForm(lines[i])) continue;

            // Rust: RAII handles it in safe code
            if (lang === 'rs' && isRustAutoDropped(lines, i)) continue;

            // Inside a cleanup context (finally, __exit__, Dispose, etc.)
            if (isInsideCleanupContext(lines, i, lang)) continue;

            // ── VARIABLE-BOUND CLEANUP CHECK ──

            const scope = findEnclosingFunction(lines, i, lang);

            if (varName) {
                // Check for cleanup using the specific variable
                const hasPairedCleanup = hasCleanupForVariable(
                    lines, varName, scope.start, scope.end, closePats, lang,
                );
                if (hasPairedCleanup) continue;
            } else {
                // No variable — check if any close exists in scope (lenient)
                const scopeBody = lines.slice(scope.start, scope.end).join('\n');
                if (closePats.some(cp => cp.test(scopeBody))) continue;
            }

            violations.push({
                rule: 'resource-leak',
                severity: 'medium',
                file, line: i + 1,
                match: lines[i].trim().substring(0, 100),
                description: varName
                    ? `Resource '${varName}' opened via ${resourceCall}() but ` +
                      `'${varName}.close()' not found in the same scope. ` +
                      `This leaks file handles, exhausting OS limits under load.`
                    : `Resource opened via ${resourceCall}() but result not stored. ` +
                      `The handle leaks immediately.`,
                hint: lang === 'py' ? 'Use `with open(...)` context manager.'
                    : lang === 'go' ? `Add \`defer ${varName || 'f'}.Close()\` immediately after open.`
                    : lang === 'cs' ? 'Use `using` statement for auto-disposal.'
                    : lang === 'java' ? 'Use try-with-resources: `try (var f = ...) { ... }`.'
                    : lang === 'rs' ? 'Ensure the handle is not leaked via `std::mem::forget`.'
                    : `Close the resource: ${varName || 'handle'}.close() in a finally block.`,
            });
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // CHECK 7: Unbounded Recursion
    //
    // SMART: Extracts function definitions, checks self-calls within
    // the function body (not global), verifies base case comes BEFORE
    // the recursive call, and checks function signature for depth params.
    // Only flags if the recursive function also does I/O (without I/O,
    // it's just a stack overflow — bad but not a side effect).
    // ═══════════════════════════════════════════════════════════════

    private checkRecursiveDepth(
        lang: SideEffectLang, lines: string[],
        file: string, violations: SideEffectViolation[],
    ): void {
        const funcDefs = extractFunctionDefs(lines, lang);

        for (const func of funcDefs) {
            const bodyLines = lines.slice(func.start + 1, func.end);
            const body = bodyLines.join('\n');

            // Check if function calls itself
            const escaped = func.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const selfCallPat = new RegExp(`\\b${escaped}\\s*\\(`);
            if (!selfCallPat.test(body)) continue;

            // Check for depth/limit parameter in function signature
            if (hasDepthParameter(func.params)) continue;

            // Check for base case BEFORE recursive call (ordering matters)
            if (hasBaseCase(bodyLines, func.name)) continue;

            // Only flag if there's I/O in the recursive function
            // (pure recursion = stack overflow, not a side-effect issue)
            if (!containsIO(body, lang)) continue;

            violations.push({
                rule: 'unbounded-recursion',
                severity: 'high',
                file, line: func.start + 1,
                match: lines[func.start].trim().substring(0, 100),
                description: `Recursive function '${func.name}' performs I/O but has no depth ` +
                    `bound or base case before the recursive call. ` +
                    `Unbounded recursion with I/O will exhaust resources ` +
                    `(stack, file handles, network connections).`,
                hint: `Add a depth/maxDepth parameter: ${func.name}(depth = 0) and ` +
                    `return when depth exceeds the limit.`,
            });
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // CHECK 8: Auto-Restart / Self-Respawn Bomb
    //
    // SMART: Detects exit/signal handlers that spawn new processes.
    // Extracts the handler body and checks for process spawn calls
    // within it. Verifies restart limits exist.
    // ═══════════════════════════════════════════════════════════════

    private checkAutoRestart(
        lang: SideEffectLang, lines: string[],
        file: string, violations: SideEffectViolation[],
    ): void {
        for (let i = 0; i < lines.length; i++) {
            if (!isExitHandler(lines[i], lang)) continue;

            // Extract the handler body
            const { body, end } = extractLoopBody(lines, i, lang);

            // Check if the handler spawns a process
            const hasSpawn = body.split('\n').some(l => isProcessSpawn(l, lang) !== null);
            if (!hasSpawn) continue;

            // Check for restart limits
            if (hasRetryLimit(lines, i, end)) continue;

            // Check for delay between restarts
            const hasDelay = /\b(?:sleep|delay|setTimeout|time\.Sleep|asyncio\.sleep|Thread\.sleep|Task\.Delay)\b/i.test(body);

            violations.push({
                rule: 'auto-restart-bomb',
                severity: 'critical',
                file, line: i + 1,
                match: lines[i].trim().substring(0, 100),
                description: `Exit/signal handler spawns a new process without restart limit. ` +
                    `If the process crashes on startup, this creates an infinite respawn ` +
                    `loop that floods the system with processes.`,
                hint: hasDelay
                    ? 'Add a maximum restart count (e.g., max 3 restarts within 5 minutes).'
                    : 'Add both a maximum restart count AND a delay between restarts.',
            });
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // OUTPUT
    // ═══════════════════════════════════════════════════════════════

    private buildFailures(violations: SideEffectViolation[]): Failure[] {
        return violations.map(v => this.createFailure(
            v.description,
            [v.file],
            v.hint,
            `Side-Effect: ${RULE_TITLES[v.rule] || v.rule}`,
            v.line,
            v.line,
            v.severity,
        ));
    }
}

const RULE_TITLES: Record<string, string> = {
    'unbounded-timer': 'Unbounded Timer',
    'orphan-process': 'Orphan Process',
    'unbounded-io-loop': 'Unbounded I/O Loop',
    'retry-without-limit': 'Retry Without Limit',
    'circular-trigger': 'Circular File Trigger',
    'resource-leak': 'Resource Leak',
    'unbounded-recursion': 'Unbounded Recursion',
    'auto-restart-bomb': 'Auto-Restart Bomb',
};
