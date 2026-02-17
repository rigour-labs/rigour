/**
 * Async & Error Safety Gate (Multi-Language)
 *
 * Detects unsafe async/promise/error patterns that AI code generators commonly produce.
 * LLMs understand synchronous control flow well but frequently produce incomplete
 * async and error-handling patterns across all languages.
 *
 * Supported languages:
 *   - JS/TS: .then() without .catch(), JSON.parse without try/catch, async without await, fetch without error handling
 *   - Python: json.loads without try/except, async def without await, requests/httpx without error handling, bare except
 *   - Go: ignored error returns (_, err pattern), json.Unmarshal without error check, http calls without error check
 *   - Ruby: JSON.parse without begin/rescue, Net::HTTP without begin/rescue
 *   - C#/.NET: JsonSerializer without try/catch, HttpClient without try/catch, async without await, .Result/.Wait() deadlocks
 *
 * @since v2.17.0
 */

import { Gate, GateContext } from './base.js';
import { Failure, Provenance } from '../types/index.js';
import { FileScanner } from '../utils/scanner.js';
import { Logger } from '../utils/logger.js';
import fs from 'fs-extra';
import path from 'path';

export interface PromiseSafetyConfig {
    enabled?: boolean;
    check_unhandled_then?: boolean;
    check_unsafe_parse?: boolean;
    check_async_without_await?: boolean;
    check_unsafe_fetch?: boolean;
    ignore_patterns?: string[];
}

interface PromiseViolation {
    file: string;
    line: number;
    type: 'unhandled-then' | 'unsafe-parse' | 'async-no-await' | 'unsafe-fetch' | 'ignored-error' | 'deadlock-risk' | 'bare-except';
    code: string;
    reason: string;
}

type Lang = 'js' | 'python' | 'go' | 'ruby' | 'csharp' | 'unknown';

// ─── Language Detection ───────────────────────────────────────────

const LANG_EXTENSIONS: Record<string, Lang> = {
    '.ts': 'js', '.tsx': 'js', '.js': 'js', '.jsx': 'js', '.mjs': 'js', '.cjs': 'js',
    '.py': 'python', '.pyw': 'python',
    '.go': 'go',
    '.rb': 'ruby', '.rake': 'ruby',
    '.cs': 'csharp',
};

const LANG_GLOBS: Record<Lang, string[]> = {
    js:      ['**/*.{ts,js,tsx,jsx,mjs,cjs}'],
    python:  ['**/*.py'],
    go:      ['**/*.go'],
    ruby:    ['**/*.rb'],
    csharp:  ['**/*.cs'],
    unknown: [],
};

function detectLang(filePath: string): Lang {
    const ext = path.extname(filePath).toLowerCase();
    return LANG_EXTENSIONS[ext] || 'unknown';
}

export class PromiseSafetyGate extends Gate {
    private config: Required<Omit<PromiseSafetyConfig, 'ignore_patterns'>> & { ignore_patterns: string[] };

    constructor(config: PromiseSafetyConfig = {}) {
        super('promise-safety', 'Async & Error Safety');
        this.config = {
            enabled: config.enabled ?? true,
            check_unhandled_then: config.check_unhandled_then ?? true,
            check_unsafe_parse: config.check_unsafe_parse ?? true,
            check_async_without_await: config.check_async_without_await ?? true,
            check_unsafe_fetch: config.check_unsafe_fetch ?? true,
            ignore_patterns: config.ignore_patterns ?? [],
        };
    }

    protected get provenance(): Provenance { return 'ai-drift'; }

    async run(context: GateContext): Promise<Failure[]> {
        if (!this.config.enabled) return [];

        const violations: PromiseViolation[] = [];

        // Scan all supported languages
        const allPatterns = Object.values(LANG_GLOBS).flat();
        const files = await FileScanner.findFiles({
            cwd: context.cwd,
            patterns: allPatterns,
            ignore: [...(context.ignore || []), '**/node_modules/**', '**/dist/**', '**/build/**',
                     '**/*.test.*', '**/*.spec.*', '**/vendor/**', '**/__pycache__/**',
                     '**/bin/Debug/**', '**/bin/Release/**', '**/obj/**', '**/venv/**', '**/.venv/**'],
        });

        Logger.info(`Async Safety: Scanning ${files.length} files across all languages`);

        for (const file of files) {
            if (this.config.ignore_patterns.some(p => new RegExp(p).test(file))) continue;

            const lang = detectLang(file);
            if (lang === 'unknown') continue;

            try {
                const fullPath = path.join(context.cwd, file);
                const content = await fs.readFile(fullPath, 'utf-8');
                const lines = content.split('\n');

                this.scanFile(lang, lines, content, file, violations);
            } catch { /* skip unreadable files */ }
        }

        return this.buildFailures(violations);
    }

    // ─── Multi-Language Dispatcher ────────────────────────

    private scanFile(lang: Lang, lines: string[], content: string, file: string, violations: PromiseViolation[]) {
        switch (lang) {
            case 'js':     this.scanJS(lines, content, file, violations); break;
            case 'python': this.scanPython(lines, content, file, violations); break;
            case 'go':     this.scanGo(lines, content, file, violations); break;
            case 'ruby':   this.scanRuby(lines, content, file, violations); break;
            case 'csharp': this.scanCSharp(lines, content, file, violations); break;
        }
    }

    // ═══════════════════════════════════════════════════════
    // JS/TS Checks
    // ═══════════════════════════════════════════════════════

    private scanJS(lines: string[], content: string, file: string, violations: PromiseViolation[]) {
        if (this.config.check_unhandled_then) this.detectUnhandledThen(lines, file, violations);
        if (this.config.check_unsafe_parse) this.detectUnsafeParseJS(lines, file, violations);
        if (this.config.check_async_without_await) this.detectAsyncWithoutAwaitJS(content, file, violations);
        if (this.config.check_unsafe_fetch) this.detectUnsafeFetchJS(lines, file, violations);
    }

    private detectUnhandledThen(lines: string[], file: string, violations: PromiseViolation[]) {
        for (let i = 0; i < lines.length; i++) {
            if (!/\.then\s*\(/.test(lines[i])) continue;

            let hasCatch = false;
            for (let j = i; j < Math.min(i + 10, lines.length); j++) {
                if (/\.catch\s*\(/.test(lines[j])) { hasCatch = true; break; }
                if (j > i && /^(?:const|let|var|function|class|export|import|if|for|while|return)\b/.test(lines[j].trim())) break;
            }
            if (!hasCatch) hasCatch = this.isInsideTryBlock(lines, i);
            const isStored = /(?:const|let|var)\s+\w+\s*=/.test(lines[i]);

            if (!hasCatch && !isStored) {
                violations.push({ file, line: i + 1, type: 'unhandled-then', code: lines[i].trim().substring(0, 80), reason: `.then() chain without .catch() — unhandled promise rejection` });
            }
        }
    }

    private detectUnsafeParseJS(lines: string[], file: string, violations: PromiseViolation[]) {
        for (let i = 0; i < lines.length; i++) {
            if (/JSON\.parse\s*\(/.test(lines[i]) && !this.isInsideTryBlock(lines, i)) {
                violations.push({ file, line: i + 1, type: 'unsafe-parse', code: lines[i].trim().substring(0, 80), reason: `JSON.parse() without try/catch — crashes on malformed input` });
            }
        }
    }

    private detectAsyncWithoutAwaitJS(content: string, file: string, violations: PromiseViolation[]) {
        const patterns = [
            /async\s+function\s+(\w+)\s*\([^)]*\)\s*\{/g,
            /(?:const|let|var)\s+(\w+)\s*=\s*async\s+(?:\([^)]*\)|[a-zA-Z_$]\w*)\s*=>\s*\{/g,
            /async\s+(\w+)\s*\([^)]*\)\s*(?::\s*[^{]+)?\s*\{/g,
        ];

        for (const pattern of patterns) {
            pattern.lastIndex = 0;
            let match;
            while ((match = pattern.exec(content)) !== null) {
                const funcName = match[1];
                const body = this.extractBraceBody(content, match.index + match[0].length);
                if (body && !/\bawait\b/.test(body) && body.trim().split('\n').length > 2) {
                    const lineNum = content.substring(0, match.index).split('\n').length;
                    violations.push({ file, line: lineNum, type: 'async-no-await', code: `async ${funcName}()`, reason: `async function '${funcName}' never uses await — unnecessary async or missing await` });
                }
            }
        }
    }

    private detectUnsafeFetchJS(lines: string[], file: string, violations: PromiseViolation[]) {
        for (let i = 0; i < lines.length; i++) {
            if (!/\bfetch\s*\(/.test(lines[i]) && !/\baxios\.\w+\s*\(/.test(lines[i])) continue;
            if (this.isInsideTryBlock(lines, i)) continue;
            if (this.hasCatchAhead(lines, i) || this.hasStatusCheckAhead(lines, i)) continue;
            violations.push({ file, line: i + 1, type: 'unsafe-fetch', code: lines[i].trim().substring(0, 80), reason: `HTTP call without error handling (no try/catch, no .catch(), no .ok check)` });
        }
    }

    // ═══════════════════════════════════════════════════════
    // Python Checks
    // ═══════════════════════════════════════════════════════

    private scanPython(lines: string[], content: string, file: string, violations: PromiseViolation[]) {
        if (this.config.check_unsafe_parse) this.detectUnsafeParsePython(lines, file, violations);
        if (this.config.check_async_without_await) this.detectAsyncWithoutAwaitPython(content, file, violations);
        if (this.config.check_unsafe_fetch) this.detectUnsafeFetchPython(lines, file, violations);
        this.detectBareExceptPython(lines, file, violations);
    }

    private detectUnsafeParsePython(lines: string[], file: string, violations: PromiseViolation[]) {
        for (let i = 0; i < lines.length; i++) {
            if (/json\.loads?\s*\(/.test(lines[i]) && !this.isInsidePythonTry(lines, i)) {
                violations.push({ file, line: i + 1, type: 'unsafe-parse', code: lines[i].trim().substring(0, 80), reason: `json.loads() without try/except — crashes on malformed input` });
            }
            if (/yaml\.safe_load\s*\(/.test(lines[i]) && !this.isInsidePythonTry(lines, i)) {
                violations.push({ file, line: i + 1, type: 'unsafe-parse', code: lines[i].trim().substring(0, 80), reason: `yaml.safe_load() without try/except — crashes on malformed input` });
            }
        }
    }

    private detectAsyncWithoutAwaitPython(content: string, file: string, violations: PromiseViolation[]) {
        const pattern = /async\s+def\s+(\w+)\s*\([^)]*\)\s*(?:->[^:]+)?:/g;
        let match;
        while ((match = pattern.exec(content)) !== null) {
            const funcName = match[1];
            const body = this.extractIndentedBody(content, match.index + match[0].length);
            if (body && !/\bawait\b/.test(body) && body.trim().split('\n').length > 2) {
                const lineNum = content.substring(0, match.index).split('\n').length;
                violations.push({ file, line: lineNum, type: 'async-no-await', code: `async def ${funcName}()`, reason: `async def '${funcName}' never uses await — unnecessary async or missing await` });
            }
        }
    }

    private detectUnsafeFetchPython(lines: string[], file: string, violations: PromiseViolation[]) {
        const httpPatterns = /\b(?:requests\.(?:get|post|put|patch|delete)|httpx\.(?:get|post|put|patch|delete)|aiohttp\.ClientSession|urllib\.request\.urlopen)\s*\(/;
        for (let i = 0; i < lines.length; i++) {
            if (!httpPatterns.test(lines[i])) continue;
            if (this.isInsidePythonTry(lines, i)) continue;

            // Check for raise_for_status() within 10 lines
            let hasCheck = false;
            for (let j = i; j < Math.min(i + 10, lines.length); j++) {
                if (/raise_for_status\s*\(/.test(lines[j]) || /\.status_code\b/.test(lines[j])) { hasCheck = true; break; }
            }
            if (!hasCheck) {
                violations.push({ file, line: i + 1, type: 'unsafe-fetch', code: lines[i].trim().substring(0, 80), reason: `HTTP call without error handling (no try/except, no raise_for_status)` });
            }
        }
    }

    private detectBareExceptPython(lines: string[], file: string, violations: PromiseViolation[]) {
        for (let i = 0; i < lines.length; i++) {
            const trimmed = lines[i].trim();
            if (/^except\s*:/.test(trimmed) || /^except\s+Exception\s*:/.test(trimmed)) {
                // Check if the except block just passes (swallows errors silently)
                const nextLine = i + 1 < lines.length ? lines[i + 1].trim() : '';
                if (nextLine === 'pass' || nextLine === '...') {
                    violations.push({ file, line: i + 1, type: 'bare-except', code: trimmed, reason: `Bare except with pass — silently swallows all errors` });
                }
            }
        }
    }

    // ═══════════════════════════════════════════════════════
    // Go Checks
    // ═══════════════════════════════════════════════════════

    private scanGo(lines: string[], content: string, file: string, violations: PromiseViolation[]) {
        if (this.config.check_unsafe_parse) this.detectUnsafeParseGo(lines, file, violations);
        if (this.config.check_unsafe_fetch) this.detectUnsafeFetchGo(lines, file, violations);
        this.detectIgnoredErrorsGo(lines, file, violations);
    }

    private detectUnsafeParseGo(lines: string[], file: string, violations: PromiseViolation[]) {
        for (let i = 0; i < lines.length; i++) {
            // json.Unmarshal returns error — check if error is ignored
            if (/json\.(?:Unmarshal|NewDecoder)/.test(lines[i])) {
                if (/\b_\s*(?:=|:=)/.test(lines[i]) || !/\berr\b/.test(lines[i])) {
                    violations.push({ file, line: i + 1, type: 'unsafe-parse', code: lines[i].trim().substring(0, 80), reason: `JSON decode with ignored error return — crashes on malformed input` });
                }
            }
        }
    }

    private detectUnsafeFetchGo(lines: string[], file: string, violations: PromiseViolation[]) {
        for (let i = 0; i < lines.length; i++) {
            if (/http\.(?:Get|Post|Do|Head)\s*\(/.test(lines[i])) {
                if (/\b_\s*(?:=|:=)/.test(lines[i]) || !/\berr\b/.test(lines[i])) {
                    violations.push({ file, line: i + 1, type: 'unsafe-fetch', code: lines[i].trim().substring(0, 80), reason: `HTTP call with ignored error return — unhandled network errors` });
                }
                // Also check if resp.Body is closed (defer resp.Body.Close())
                let hasClose = false;
                for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
                    if (/defer\s+.*\.Body\.Close\(\)/.test(lines[j]) || /\.Body\.Close\(\)/.test(lines[j])) { hasClose = true; break; }
                }
                if (!hasClose && /\berr\b/.test(lines[i])) {
                    // Don't flag if error IS checked — only flag missing Body.Close
                    // This is a softer check, skip for now to reduce noise
                }
            }
        }
    }

    private detectIgnoredErrorsGo(lines: string[], file: string, violations: PromiseViolation[]) {
        for (let i = 0; i < lines.length; i++) {
            // Detect: result, _ := someFunc() or _ = someFunc()
            // Only flag when the ignored return is likely an error
            const match = lines[i].match(/(\w+)\s*,\s*_\s*(?::=|=)\s*(\w+)\./);
            if (match) {
                const funcCall = lines[i].trim();
                // Common error-returning functions
                if (/\b(?:os\.|io\.|ioutil\.|bufio\.|sql\.|net\.|http\.|json\.|xml\.|yaml\.|strconv\.)/.test(funcCall)) {
                    violations.push({ file, line: i + 1, type: 'ignored-error', code: funcCall.substring(0, 80), reason: `Error return ignored with _ — unhandled error can cause silent failures` });
                }
            }
        }
    }

    // ═══════════════════════════════════════════════════════
    // Ruby Checks
    // ═══════════════════════════════════════════════════════

    private scanRuby(lines: string[], content: string, file: string, violations: PromiseViolation[]) {
        if (this.config.check_unsafe_parse) this.detectUnsafeParseRuby(lines, file, violations);
        if (this.config.check_unsafe_fetch) this.detectUnsafeFetchRuby(lines, file, violations);
    }

    private detectUnsafeParseRuby(lines: string[], file: string, violations: PromiseViolation[]) {
        for (let i = 0; i < lines.length; i++) {
            if (/JSON\.parse\s*\(/.test(lines[i]) && !this.isInsideRubyRescue(lines, i)) {
                violations.push({ file, line: i + 1, type: 'unsafe-parse', code: lines[i].trim().substring(0, 80), reason: `JSON.parse without begin/rescue — crashes on malformed input` });
            }
            if (/YAML\.(?:safe_)?load\s*\(/.test(lines[i]) && !this.isInsideRubyRescue(lines, i)) {
                violations.push({ file, line: i + 1, type: 'unsafe-parse', code: lines[i].trim().substring(0, 80), reason: `YAML.load without begin/rescue — crashes on malformed input` });
            }
        }
    }

    private detectUnsafeFetchRuby(lines: string[], file: string, violations: PromiseViolation[]) {
        for (let i = 0; i < lines.length; i++) {
            if (/Net::HTTP\.(?:get|post|start)\s*\(/.test(lines[i]) || /HTTParty\.(?:get|post)\s*\(/.test(lines[i]) || /Faraday\.(?:get|post)\s*\(/.test(lines[i])) {
                if (!this.isInsideRubyRescue(lines, i)) {
                    violations.push({ file, line: i + 1, type: 'unsafe-fetch', code: lines[i].trim().substring(0, 80), reason: `HTTP call without begin/rescue — unhandled network errors` });
                }
            }
        }
    }

    // ═══════════════════════════════════════════════════════
    // C# / .NET Checks
    // ═══════════════════════════════════════════════════════

    private scanCSharp(lines: string[], content: string, file: string, violations: PromiseViolation[]) {
        if (this.config.check_unsafe_parse) this.detectUnsafeParseCSharp(lines, file, violations);
        if (this.config.check_unsafe_fetch) this.detectUnsafeFetchCSharp(lines, file, violations);
        if (this.config.check_async_without_await) this.detectAsyncWithoutAwaitCSharp(content, file, violations);
        this.detectDeadlockRiskCSharp(lines, file, violations);
    }

    private detectUnsafeParseCSharp(lines: string[], file: string, violations: PromiseViolation[]) {
        for (let i = 0; i < lines.length; i++) {
            if (/JsonSerializer\.Deserialize/.test(lines[i]) || /JsonConvert\.DeserializeObject/.test(lines[i]) || /JObject\.Parse/.test(lines[i])) {
                if (!this.isInsideTryBlock(lines, i)) {
                    violations.push({ file, line: i + 1, type: 'unsafe-parse', code: lines[i].trim().substring(0, 80), reason: `JSON deserialization without try/catch — crashes on malformed input` });
                }
            }
        }
    }

    private detectUnsafeFetchCSharp(lines: string[], file: string, violations: PromiseViolation[]) {
        for (let i = 0; i < lines.length; i++) {
            if (/\.GetAsync\s*\(/.test(lines[i]) || /\.PostAsync\s*\(/.test(lines[i]) || /\.SendAsync\s*\(/.test(lines[i]) || /HttpClient\.\w+Async/.test(lines[i])) {
                if (!this.isInsideTryBlock(lines, i)) {
                    let hasCheck = false;
                    for (let j = i; j < Math.min(i + 10, lines.length); j++) {
                        if (/EnsureSuccessStatusCode/.test(lines[j]) || /\.IsSuccessStatusCode/.test(lines[j]) || /\.StatusCode/.test(lines[j])) { hasCheck = true; break; }
                    }
                    if (!hasCheck) {
                        violations.push({ file, line: i + 1, type: 'unsafe-fetch', code: lines[i].trim().substring(0, 80), reason: `HTTP call without error handling (no try/catch, no status check)` });
                    }
                }
            }
        }
    }

    private detectAsyncWithoutAwaitCSharp(content: string, file: string, violations: PromiseViolation[]) {
        const pattern = /async\s+Task(?:<[^>]+>)?\s+(\w+)\s*\([^)]*\)\s*\{/g;
        let match;
        while ((match = pattern.exec(content)) !== null) {
            const funcName = match[1];
            const body = this.extractBraceBody(content, match.index + match[0].length);
            if (body && !/\bawait\b/.test(body) && body.trim().split('\n').length > 2) {
                const lineNum = content.substring(0, match.index).split('\n').length;
                violations.push({ file, line: lineNum, type: 'async-no-await', code: `async Task ${funcName}()`, reason: `async method '${funcName}' never uses await — unnecessary async or missing await` });
            }
        }
    }

    private detectDeadlockRiskCSharp(lines: string[], file: string, violations: PromiseViolation[]) {
        for (let i = 0; i < lines.length; i++) {
            if (/\.Result\b/.test(lines[i]) || /\.Wait\(\)/.test(lines[i]) || /\.GetAwaiter\(\)\.GetResult\(\)/.test(lines[i])) {
                // Common AI mistake: using .Result or .Wait() on async tasks causes deadlocks
                violations.push({ file, line: i + 1, type: 'deadlock-risk', code: lines[i].trim().substring(0, 80), reason: `.Result/.Wait() on async task — deadlock risk in synchronous context` });
            }
        }
    }

    // ═══════════════════════════════════════════════════════
    // Shared Helpers
    // ═══════════════════════════════════════════════════════

    private extractBraceBody(content: string, startIdx: number): string | null {
        let depth = 1;
        let idx = startIdx;
        while (depth > 0 && idx < content.length) {
            if (content[idx] === '{') depth++;
            if (content[idx] === '}') depth--;
            idx++;
        }
        return depth === 0 ? content.substring(startIdx, idx - 1) : null;
    }

    /** Extract Python indented body after a colon */
    private extractIndentedBody(content: string, startIdx: number): string | null {
        const rest = content.substring(startIdx);
        const lines = rest.split('\n');
        if (lines.length < 2) return null;

        // Find indent level of first non-empty line after the def
        let bodyIndent = -1;
        const bodyLines: string[] = [];

        for (let i = 1; i < lines.length; i++) {
            const line = lines[i];
            if (line.trim() === '' || line.trim().startsWith('#')) { bodyLines.push(line); continue; }
            const indent = line.length - line.trimStart().length;
            if (bodyIndent === -1) { bodyIndent = indent; }
            if (indent < bodyIndent) break;
            bodyLines.push(line);
        }
        return bodyLines.join('\n');
    }

    /** Check if line is inside try block (JS/TS/C# — brace-based) */
    private isInsideTryBlock(lines: string[], lineIdx: number): boolean {
        let braceDepth = 0;
        for (let j = lineIdx - 1; j >= Math.max(0, lineIdx - 30); j--) {
            const prevLine = this.stripStrings(lines[j]);
            for (const ch of prevLine) {
                if (ch === '}') braceDepth++;
                if (ch === '{') braceDepth--;
            }
            if (/\btry\s*\{/.test(prevLine) && braceDepth <= 0) return true;
            if (/\}\s*catch\s*\(/.test(prevLine)) return false;
        }
        return false;
    }

    /** Check if line is inside Python try block (indent-based) */
    private isInsidePythonTry(lines: string[], lineIdx: number): boolean {
        const lineIndent = lines[lineIdx].length - lines[lineIdx].trimStart().length;
        for (let j = lineIdx - 1; j >= Math.max(0, lineIdx - 30); j--) {
            const trimmed = lines[j].trim();
            if (trimmed === '') continue;
            const indent = lines[j].length - lines[j].trimStart().length;
            if (indent < lineIndent && /^\s*try\s*:/.test(lines[j])) return true;
            if (indent < lineIndent && /^\s*(?:except|finally)\s*/.test(lines[j])) return false;
            if (indent === 0 && /^(?:def|class|async\s+def)\s/.test(trimmed)) break;
        }
        return false;
    }

    /** Check if line is inside Ruby begin/rescue block */
    private isInsideRubyRescue(lines: string[], lineIdx: number): boolean {
        for (let j = lineIdx - 1; j >= Math.max(0, lineIdx - 30); j--) {
            const trimmed = lines[j].trim();
            if (trimmed === 'begin') return true;
            if (/^rescue\b/.test(trimmed)) return false;
            if (/^(?:def|class|module)\s/.test(trimmed)) break;
        }
        return false;
    }

    private hasCatchAhead(lines: string[], idx: number): boolean {
        for (let j = idx; j < Math.min(idx + 10, lines.length); j++) {
            if (/\.catch\s*\(/.test(lines[j])) return true;
        }
        return false;
    }

    private hasStatusCheckAhead(lines: string[], idx: number): boolean {
        for (let j = idx; j < Math.min(idx + 10, lines.length); j++) {
            if (/\.\s*ok\b/.test(lines[j]) || /\.status(?:Text)?\b/.test(lines[j])) return true;
        }
        return false;
    }

    private stripStrings(line: string): string {
        return line.replace(/`[^`]*`/g, '""').replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, '""');
    }

    // ─── Failure Aggregation ──────────────────────────────

    private buildFailures(violations: PromiseViolation[]): Failure[] {
        const byFile = new Map<string, PromiseViolation[]>();
        for (const v of violations) {
            const existing = byFile.get(v.file) || [];
            existing.push(v);
            byFile.set(v.file, existing);
        }

        const failures: Failure[] = [];
        for (const [file, fileViolations] of byFile) {
            const details = fileViolations.map(v => `  L${v.line}: [${v.type}] ${v.reason}`).join('\n');
            const hasHighSev = fileViolations.some(v => v.type !== 'async-no-await');
            const severity = hasHighSev ? 'high' : 'medium';
            const lang = detectLang(file);
            const langLabel = lang === 'js' ? 'JS/TS' : lang === 'csharp' ? 'C#' : lang.charAt(0).toUpperCase() + lang.slice(1);

            failures.push(this.createFailure(
                `Unsafe async/error patterns in ${file}:\n${details}`,
                [file],
                `AI code generators often produce incomplete error handling in ${langLabel}. Ensure all parse operations are wrapped in error handling, async functions use await, and HTTP calls check for errors.`,
                'Async & Error Safety Violation',
                fileViolations[0].line,
                undefined,
                severity as any
            ));
        }
        return failures;
    }
}
