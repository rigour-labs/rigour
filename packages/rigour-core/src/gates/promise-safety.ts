/**
 * Async & Error Safety Gate (Multi-Language)
 *
 * Detects unsafe async/promise/error patterns that AI code generators commonly produce.
 * Supports: JS/TS, Python, Go, Ruby, C#/.NET
 *
 * @since v2.17.0
 */

import { Gate, GateContext } from './base.js';
import { Failure, Provenance } from '../types/index.js';
import { FileScanner } from '../utils/scanner.js';
import { Logger } from '../utils/logger.js';
import { LANG_EXTENSIONS, LANG_GLOBS, Lang } from './promise-safety-rules.js';
import { PromiseViolation, extractBraceBody, extractIndentedBody, isInsideTryBlock, isInsidePythonTry, isInsideRubyRescue, hasCatchAhead, hasStatusCheckAhead } from './promise-safety-helpers.js';
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
            } catch { /* skip */ }
        }

        return this.buildFailures(violations);
    }

    private scanFile(lang: Lang, lines: string[], content: string, file: string, violations: PromiseViolation[]) {
        switch (lang) {
            case 'js': return this.scanJS(lines, content, file, violations);
            case 'python': return this.scanPython(lines, content, file, violations);
            case 'go': return this.scanGo(lines, content, file, violations);
            case 'ruby': return this.scanRuby(lines, content, file, violations);
            case 'csharp': return this.scanCSharp(lines, content, file, violations);
        }
    }

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
            if (!hasCatch && !isInsideTryBlock(lines, i) && !/(?:const|let|var)\s+\w+\s*=/.test(lines[i])) {
                violations.push({ file, line: i + 1, type: 'unhandled-then', code: lines[i].trim().substring(0, 80), reason: `.then() chain without .catch() — unhandled promise rejection` });
            }
        }
    }

    private detectUnsafeParseJS(lines: string[], file: string, violations: PromiseViolation[]) {
        for (let i = 0; i < lines.length; i++) {
            if (/JSON\.parse\s*\(/.test(lines[i]) && !isInsideTryBlock(lines, i)) {
                violations.push({ file, line: i + 1, type: 'unsafe-parse', code: lines[i].trim().substring(0, 80), reason: `JSON.parse() without try/catch — crashes on malformed input` });
            }
        }
    }

    private detectAsyncWithoutAwaitJS(content: string, file: string, violations: PromiseViolation[]) {
        const patterns = [/async\s+function\s+(\w+)\s*\([^)]*\)\s*\{/g, /(?:const|let|var)\s+(\w+)\s*=\s*async\s+(?:\([^)]*\)|[a-zA-Z_$]\w*)\s*=>\s*\{/g];
        for (const pattern of patterns) {
            pattern.lastIndex = 0;
            let match;
            while ((match = pattern.exec(content)) !== null) {
                const funcName = match[1];
                const body = extractBraceBody(content, match.index + match[0].length);
                if (body && !/\bawait\b/.test(body) && body.trim().split('\n').length > 2) {
                    const lineNum = content.substring(0, match.index).split('\n').length;
                    violations.push({ file, line: lineNum, type: 'async-no-await', code: `async ${funcName}()`, reason: `async function never uses await — unnecessary async or missing await` });
                }
            }
        }
    }

    private detectUnsafeFetchJS(lines: string[], file: string, violations: PromiseViolation[]) {
        for (let i = 0; i < lines.length; i++) {
            if (!/\bfetch\s*\(/.test(lines[i]) && !/\baxios\.\w+\s*\(/.test(lines[i])) continue;
            if (isInsideTryBlock(lines, i) || hasCatchAhead(lines, i) || hasStatusCheckAhead(lines, i)) continue;
            violations.push({ file, line: i + 1, type: 'unsafe-fetch', code: lines[i].trim().substring(0, 80), reason: `HTTP call without error handling` });
        }
    }

    private scanPython(lines: string[], content: string, file: string, violations: PromiseViolation[]) {
        if (this.config.check_unsafe_parse) this.detectUnsafeParsePython(lines, file, violations);
        if (this.config.check_async_without_await) this.detectAsyncWithoutAwaitPython(content, file, violations);
        if (this.config.check_unsafe_fetch) this.detectUnsafeFetchPython(lines, file, violations);
        this.detectBareExceptPython(lines, file, violations);
    }

    private detectUnsafeParsePython(lines: string[], file: string, violations: PromiseViolation[]) {
        for (let i = 0; i < lines.length; i++) {
            if (/json\.loads?\s*\(/.test(lines[i]) && !isInsidePythonTry(lines, i)) {
                violations.push({ file, line: i + 1, type: 'unsafe-parse', code: lines[i].trim().substring(0, 80), reason: `json.loads() without try/except` });
            }
        }
    }

    private detectAsyncWithoutAwaitPython(content: string, file: string, violations: PromiseViolation[]) {
        const pattern = /async\s+def\s+(\w+)\s*\([^)]*\)\s*(?:->[^:]+)?:/g;
        let match;
        while ((match = pattern.exec(content)) !== null) {
            const funcName = match[1];
            const body = extractIndentedBody(content, match.index + match[0].length);
            if (body && !/\bawait\b/.test(body) && body.trim().split('\n').length > 2) {
                const lineNum = content.substring(0, match.index).split('\n').length;
                violations.push({ file, line: lineNum, type: 'async-no-await', code: `async def ${funcName}()`, reason: `async def never uses await` });
            }
        }
    }

    private detectUnsafeFetchPython(lines: string[], file: string, violations: PromiseViolation[]) {
        const httpPatterns = /\b(?:requests|httpx|aiohttp|urllib)\.(?:get|post|ClientSession|urlopen)\s*\(/;
        for (let i = 0; i < lines.length; i++) {
            if (!httpPatterns.test(lines[i]) || isInsidePythonTry(lines, i)) continue;
            let hasCheck = false;
            for (let j = i; j < Math.min(i + 10, lines.length); j++) {
                if (/raise_for_status|status_code/.test(lines[j])) { hasCheck = true; break; }
            }
            if (!hasCheck) {
                violations.push({ file, line: i + 1, type: 'unsafe-fetch', code: lines[i].trim().substring(0, 80), reason: `HTTP call without error handling` });
            }
        }
    }

    private detectBareExceptPython(lines: string[], file: string, violations: PromiseViolation[]) {
        for (let i = 0; i < lines.length; i++) {
            const trimmed = lines[i].trim();
            if (/^except\s*:/.test(trimmed) || /^except\s+Exception\s*:/.test(trimmed)) {
                const nextLine = i + 1 < lines.length ? lines[i + 1].trim() : '';
                if (nextLine === 'pass' || nextLine === '...') {
                    violations.push({ file, line: i + 1, type: 'bare-except', code: trimmed, reason: `Bare except with pass — silently swallows errors` });
                }
            }
        }
    }

    private scanGo(lines: string[], content: string, file: string, violations: PromiseViolation[]) {
        if (this.config.check_unsafe_parse) this.detectUnsafeParseGo(lines, file, violations);
        if (this.config.check_unsafe_fetch) this.detectUnsafeFetchGo(lines, file, violations);
        this.detectIgnoredErrorsGo(lines, file, violations);
    }

    private detectUnsafeParseGo(lines: string[], file: string, violations: PromiseViolation[]) {
        for (let i = 0; i < lines.length; i++) {
            if (/json\.(?:Unmarshal|NewDecoder)/.test(lines[i]) && (/\b_\s*(?:=|:=)/.test(lines[i]) || !/\berr\b/.test(lines[i]))) {
                violations.push({ file, line: i + 1, type: 'unsafe-parse', code: lines[i].trim().substring(0, 80), reason: `JSON decode with ignored error` });
            }
        }
    }

    private detectUnsafeFetchGo(lines: string[], file: string, violations: PromiseViolation[]) {
        for (let i = 0; i < lines.length; i++) {
            if (/http\.(?:Get|Post|Do|Head)\s*\(/.test(lines[i]) && (/\b_\s*(?:=|:=)/.test(lines[i]) || !/\berr\b/.test(lines[i]))) {
                violations.push({ file, line: i + 1, type: 'unsafe-fetch', code: lines[i].trim().substring(0, 80), reason: `HTTP call with ignored error` });
            }
        }
    }

    private detectIgnoredErrorsGo(lines: string[], file: string, violations: PromiseViolation[]) {
        for (let i = 0; i < lines.length; i++) {
            const match = lines[i].match(/(\w+)\s*,\s*_\s*(?::=|=)\s*(\w+)\./);
            if (match && /\b(?:os|io|ioutil|bufio|sql|net|http|json|xml|yaml|strconv)\./.test(lines[i].trim())) {
                violations.push({ file, line: i + 1, type: 'ignored-error', code: lines[i].trim().substring(0, 80), reason: `Error return ignored with _` });
            }
        }
    }

    private scanRuby(lines: string[], content: string, file: string, violations: PromiseViolation[]) {
        if (this.config.check_unsafe_parse) this.detectUnsafeParseRuby(lines, file, violations);
        if (this.config.check_unsafe_fetch) this.detectUnsafeFetchRuby(lines, file, violations);
    }

    private detectUnsafeParseRuby(lines: string[], file: string, violations: PromiseViolation[]) {
        for (let i = 0; i < lines.length; i++) {
            if (/JSON\.parse\s*\(/.test(lines[i]) && !isInsideRubyRescue(lines, i)) {
                violations.push({ file, line: i + 1, type: 'unsafe-parse', code: lines[i].trim().substring(0, 80), reason: `JSON.parse without begin/rescue` });
            }
        }
    }

    private detectUnsafeFetchRuby(lines: string[], file: string, violations: PromiseViolation[]) {
        for (let i = 0; i < lines.length; i++) {
            if (/(?:Net::HTTP|HTTParty|Faraday)\.(?:get|post|start)\s*\(/.test(lines[i]) && !isInsideRubyRescue(lines, i)) {
                violations.push({ file, line: i + 1, type: 'unsafe-fetch', code: lines[i].trim().substring(0, 80), reason: `HTTP call without begin/rescue` });
            }
        }
    }

    private scanCSharp(lines: string[], content: string, file: string, violations: PromiseViolation[]) {
        if (this.config.check_unsafe_parse) this.detectUnsafeParseCSharp(lines, file, violations);
        if (this.config.check_unsafe_fetch) this.detectUnsafeFetchCSharp(lines, file, violations);
        if (this.config.check_async_without_await) this.detectAsyncWithoutAwaitCSharp(content, file, violations);
        this.detectDeadlockRiskCSharp(lines, file, violations);
    }

    private detectUnsafeParseCSharp(lines: string[], file: string, violations: PromiseViolation[]) {
        for (let i = 0; i < lines.length; i++) {
            if (/JsonSerializer|JsonConvert|JObject/.test(lines[i]) && !isInsideTryBlock(lines, i)) {
                violations.push({ file, line: i + 1, type: 'unsafe-parse', code: lines[i].trim().substring(0, 80), reason: `JSON deserialization without try/catch` });
            }
        }
    }

    private detectUnsafeFetchCSharp(lines: string[], file: string, violations: PromiseViolation[]) {
        for (let i = 0; i < lines.length; i++) {
            if (/\.(?:GetAsync|PostAsync|SendAsync)\s*\(/.test(lines[i]) && !isInsideTryBlock(lines, i)) {
                let hasCheck = false;
                for (let j = i; j < Math.min(i + 10, lines.length); j++) {
                    if (/EnsureSuccess|IsSuccessStatusCode|StatusCode/.test(lines[j])) { hasCheck = true; break; }
                }
                if (!hasCheck) {
                    violations.push({ file, line: i + 1, type: 'unsafe-fetch', code: lines[i].trim().substring(0, 80), reason: `HTTP call without error handling` });
                }
            }
        }
    }

    private detectAsyncWithoutAwaitCSharp(content: string, file: string, violations: PromiseViolation[]) {
        const pattern = /async\s+Task(?:<[^>]+>)?\s+(\w+)\s*\([^)]*\)\s*\{/g;
        let match;
        while ((match = pattern.exec(content)) !== null) {
            const funcName = match[1];
            const body = extractBraceBody(content, match.index + match[0].length);
            if (body && !/\bawait\b/.test(body) && body.trim().split('\n').length > 2) {
                const lineNum = content.substring(0, match.index).split('\n').length;
                violations.push({ file, line: lineNum, type: 'async-no-await', code: `async Task ${funcName}()`, reason: `async method never uses await` });
            }
        }
    }

    private detectDeadlockRiskCSharp(lines: string[], file: string, violations: PromiseViolation[]) {
        for (let i = 0; i < lines.length; i++) {
            if (/\.Result\b|\.Wait\(\)|\.GetAwaiter\(\)\.GetResult\(\)/.test(lines[i])) {
                violations.push({ file, line: i + 1, type: 'deadlock-risk', code: lines[i].trim().substring(0, 80), reason: `.Result/.Wait() on async task — deadlock risk` });
            }
        }
    }

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
            failures.push(this.createFailure(
                `Unsafe async/error patterns in ${file}:\n${details}`,
                [file],
                `Review and fix async/error handling patterns.`,
                'Async & Error Safety Violation',
                fileViolations[0].line,
                undefined,
                severity as any
            ));
        }
        return failures;
    }
}
