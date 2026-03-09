import { SideEffectLang, stripStrings } from './types.js';
import { findBlockEndBrace } from './scope-analysis.js';

// ═══════════════════════════════════════════════════════════════════
// VARIABLE BINDING — Track resource creation → cleanup pairs
// ═══════════════════════════════════════════════════════════════════

/**
 * Extract the variable name from an assignment.
 * "const timer = setInterval(...)"  → "timer"
 * "let fd = fs.open(...)"           → "fd"
 * "self.watcher = chokidar.watch()" → "self.watcher"
 * "timer := time.NewTicker(...)"    → "timer" (Go)
 *
 * Returns null if the call result is NOT stored in a variable.
 */
export function extractVariableBinding(line: string, lang: SideEffectLang): string | null {
    const stripped = stripStrings(line).trim();

    if (lang === 'go') {
        // Go: `ticker := time.NewTicker(...)` or `ticker, _ := ...`
        const goMatch = stripped.match(/^(\w+)(?:\s*,\s*\w+)*\s*:?=\s*/);
        if (goMatch) return goMatch[1];
        return null;
    }

    if (lang === 'py') {
        // Python: `timer = threading.Timer(...)` or `self.timer = ...`
        const pyMatch = stripped.match(/^((?:self\.)?[\w.]+)\s*=\s*(?!==)/);
        if (pyMatch) return pyMatch[1];
        return null;
    }

    if (lang === 'rb') {
        // Ruby: `@watcher = Listen.to(...)` or `watcher = ...`
        const rbMatch = stripped.match(/^(@?\w+)\s*=\s*/);
        if (rbMatch) return rbMatch[1];
        return null;
    }

    // JS/TS/Java/C#/Rust: `const x = ...`, `let x = ...`, `var x = ...`, `auto x = ...`
    const jsMatch = stripped.match(/^(?:const|let|var|final|auto|val)\s+(\w+)\s*=\s*/);
    if (jsMatch) return jsMatch[1];

    // Member assignment: `this.timer = ...`, `self.timer = ...`
    const memberMatch = stripped.match(/^(?:this|self)\.([\w]+)\s*=\s*/);
    if (memberMatch) return memberMatch[1];

    // Simple assignment: `timer = ...`
    const simpleMatch = stripped.match(/^(\w+)\s*=\s*(?!==)/);
    if (simpleMatch) {
        // Exclude control flow keywords
        const name = simpleMatch[1];
        if (['if', 'for', 'while', 'switch', 'return', 'throw'].includes(name)) return null;
        return name;
    }

    return null;
}

/**
 * Check if a specific variable is used in a cleanup call within a scope.
 *
 * Unlike the naive "does clearInterval exist in the file?", this checks:
 * 1. The cleanup function references the specific variable
 * 2. The cleanup is within the correct scope (same function or cleanup callback)
 *
 * Example: for variable "timer" and cleanup patterns [/clearInterval/],
 * matches: `clearInterval(timer)`, `clearInterval(this.timer)`, `timer.close()`
 */
export function hasCleanupForVariable(
    lines: string[],
    varName: string,
    scopeStart: number,
    scopeEnd: number,
    cleanupPatterns: RegExp[],
    lang: SideEffectLang,
): boolean {
    const scope = lines.slice(scopeStart, scopeEnd);

    for (let i = 0; i < scope.length; i++) {
        const stripped = stripStrings(scope[i]);

        // Check cleanup patterns that reference the specific variable
        for (const pat of cleanupPatterns) {
            if (!pat.test(stripped)) continue;

            // The cleanup call should reference our variable
            const escapedVar = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const varRef = new RegExp(`\\b${escapedVar}\\b`);
            if (varRef.test(stripped)) return true;

            // Also check method calls on the variable: timer.close(), timer.stop()
            // The pattern might match a generic .close() — check if it's on our var
        }

        // Direct method cleanup on the variable: varName.close(), varName.Stop()
        const escapedVar = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const methodCleanup = new RegExp(
            `\\b${escapedVar}\\.(?:close|stop|destroy|kill|terminate|dispose|cancel|shutdown|unsubscribe|disconnect|end|release|Clear|Stop|Dispose|Close|Cancel)\\s*\\(`
        );
        if (methodCleanup.test(stripped)) return true;
    }

    return false;
}

/**
 * Check if a line is inside a cleanup/teardown context.
 *
 * Cleanup contexts where resource cleanup is expected:
 * - JS/TS: useEffect return function, componentWillUnmount, beforeDestroy, ngOnDestroy, dispose()
 * - Python: __del__, __exit__, close(), cleanup(), teardown
 * - Go: defer statement
 * - Java: finally block, close() method, @PreDestroy
 * - C#: Dispose(), using block, finalizer
 * - Ruby: ensure block, at_exit
 */
export function isInsideCleanupContext(
    lines: string[], lineIdx: number, lang: SideEffectLang,
): boolean {
    // Scan backwards up to 30 lines for cleanup context markers
    for (let j = lineIdx; j >= Math.max(0, lineIdx - 30); j--) {
        const trimmed = lines[j].trim();

        switch (lang) {
            case 'js':
            case 'ts':
                // React useEffect cleanup: `return () => { cleanup }`
                if (/\breturn\s+(?:\(\)\s*=>|function\s*\()/.test(trimmed)) return true;
                // Lifecycle: componentWillUnmount, ngOnDestroy, beforeDestroy
                if (/\b(?:componentWillUnmount|ngOnDestroy|beforeDestroy|dispose)\s*\(/.test(trimmed)) return true;
                // Event: 'beforeunload', 'unload'
                if (/['"](?:beforeunload|unload)['"]\s*,/.test(trimmed)) return true;
                break;

            case 'py':
                if (/\bdef\s+(?:__del__|__exit__|close|cleanup|teardown|dispose)\s*\(/.test(trimmed)) return true;
                if (/\bfinally\s*:/.test(trimmed)) return true;
                break;

            case 'go':
                if (/\bdefer\b/.test(trimmed)) return true;
                break;

            case 'java':
                if (/\bfinally\s*\{/.test(trimmed)) return true;
                if (/\b(?:close|destroy|cleanup|dispose)\s*\(/.test(trimmed)) return true;
                if (/@PreDestroy/.test(trimmed)) return true;
                break;

            case 'cs':
                if (/\bDispose\s*\(/.test(trimmed)) return true;
                if (/\busing\s*\(/.test(trimmed)) return true;
                if (/~\w+\s*\(/.test(trimmed)) return true;  // finalizer
                break;

            case 'rb':
                if (/\bensure\b/.test(trimmed)) return true;
                break;

            case 'rs':
                if (/\bimpl\s+Drop\b/.test(trimmed)) return true;
                break;
        }

        // Stop at function boundaries
        if (isFunctionBoundary(trimmed, lang)) break;
    }
    return false;
}


// ═══════════════════════════════════════════════════════════════════
// FRAMEWORK-AWARE PATTERNS — Detect safe idioms per ecosystem
// ═══════════════════════════════════════════════════════════════════

/**
 * Check if a timer/resource creation is inside a React useEffect
 * that returns a cleanup function.
 *
 * Pattern:
 *   useEffect(() => {
 *     const timer = setInterval(...)  ← creation
 *     return () => clearInterval(timer)  ← cleanup
 *   }, [deps])
 */
export function isInUseEffectWithCleanup(
    lines: string[], lineIdx: number,
): boolean {
    // Walk backwards to find useEffect
    let braceDepth = 0;
    for (let j = lineIdx; j >= Math.max(0, lineIdx - 30); j--) {
        const stripped = stripStrings(lines[j]);
        for (const ch of stripped) {
            if (ch === '}') braceDepth++;
            if (ch === '{') braceDepth--;
        }
        if (/\buseEffect\s*\(/.test(stripped) && braceDepth <= 0) {
            // Found enclosing useEffect — now check if it has a return () => ...
            const effectEnd = findBlockEndBrace(lines, j);
            const effectBody = lines.slice(j, effectEnd).join('\n');
            // Look for cleanup return: `return () =>` or `return function`
            if (/\breturn\s+(?:\(\)\s*=>|function\s*\()/.test(effectBody)) {
                return true;
            }
            return false;
        }
    }
    return false;
}

/**
 * Check if a Go resource open is immediately followed by defer close.
 *
 * Idiomatic Go:
 *   f, err := os.Open(path)
 *   if err != nil { return err }
 *   defer f.Close()
 */
export function hasGoDefer(lines: string[], openLine: number, varName: string): boolean {
    // Check lines between open and open+5 for defer using the variable
    const escaped = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const deferPat = new RegExp(`\\bdefer\\s+${escaped}\\.`);

    for (let j = openLine + 1; j < Math.min(lines.length, openLine + 6); j++) {
        if (deferPat.test(lines[j])) return true;
        // Also match: defer func() { varName.Close() }()
        if (/\bdefer\s+func\s*\(\)/.test(lines[j])) {
            const endDefer = findBlockEndBrace(lines, j);
            const body = lines.slice(j, endDefer).join('\n');
            if (new RegExp(`\\b${escaped}\\.`).test(body)) return true;
        }
    }
    return false;
}

/**
 * Check if a Python open() is inside a `with` statement (context manager).
 */
export function isPythonWithStatement(line: string): boolean {
    return /\bwith\s+/.test(stripStrings(line));
}

/**
 * Check if a Java resource open is inside try-with-resources.
 * Pattern: try (var x = new FileStream(...)) { ... }
 */
export function isJavaTryWithResources(lines: string[], lineIdx: number): boolean {
    for (let j = lineIdx; j >= Math.max(0, lineIdx - 3); j--) {
        if (/\btry\s*\(/.test(stripStrings(lines[j]))) return true;
    }
    return false;
}

/**
 * Check if a C# resource is inside a using statement/declaration.
 * Patterns: `using (var x = ...)` or `using var x = ...` (C# 8+)
 */
export function isCSharpUsing(line: string): boolean {
    const stripped = stripStrings(line);
    return /\busing\s*\(/.test(stripped) || /\busing\s+(?:var|await)\b/.test(stripped);
}

/**
 * Check if a Ruby File.open uses block form (auto-closes).
 * Pattern: File.open(path) do |f| ... end
 *          File.open(path) { |f| ... }
 */
export function isRubyBlockForm(line: string): boolean {
    return /\bdo\s*\|/.test(line) || /\{\s*\|/.test(line);
}

/**
 * Check if a Rust resource is automatically dropped (RAII).
 * In Rust, all resources are dropped when they go out of scope,
 * so we only flag resources in unsafe blocks or static/global context.
 */
export function isRustAutoDropped(lines: string[], lineIdx: number): boolean {
    // Check if inside unsafe block (manual memory management)
    for (let j = lineIdx; j >= Math.max(0, lineIdx - 20); j--) {
        if (/\bunsafe\s*\{/.test(lines[j])) return false;  // Not auto-dropped in unsafe
    }
    return true;  // Normal Rust = RAII applies
}

function isFunctionBoundary(trimmed: string, lang: SideEffectLang): boolean {
    switch (lang) {
        case 'py':
            return /^(?:def|class|async\s+def)\s/.test(trimmed);
        case 'go':
            return /^func\s/.test(trimmed);
        case 'rb':
            return /^(?:def|class|module)\s/.test(trimmed);
        case 'rs':
            return /^(?:fn|impl|pub\s+fn|pub\s+async\s+fn)\s/.test(trimmed);
        default:
            return /^(?:export\s+)?(?:async\s+)?(?:function|class)\s/.test(trimmed);
    }
}
