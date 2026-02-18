/**
 * Lightweight per-file checker for hook integration.
 *
 * Runs a fast subset of Rigour gates on individual files,
 * designed to complete in <200ms for real-time hook feedback.
 *
 * Used by all tool-specific hooks (Claude, Cursor, Cline, Windsurf).
 *
 * @since v3.0.0
 */

import fs from 'fs-extra';
import path from 'path';
import yaml from 'yaml';
import { ConfigSchema, Config } from '../types/index.js';
import type { HookCheckerResult } from './types.js';

type FailureEntry = HookCheckerResult['failures'][number];

interface CheckerOptions {
    cwd: string;
    files: string[];
    timeout_ms?: number;
    block_on_failure?: boolean;
}

const JS_TS_PATTERN = /\.(ts|tsx|js|jsx|mts|mjs)$/;

/**
 * Load rigour config from cwd, falling back to defaults.
 */
async function loadConfig(cwd: string): Promise<Config> {
    const configPath = path.join(cwd, 'rigour.yml');
    if (await fs.pathExists(configPath)) {
        const raw = yaml.parse(await fs.readFile(configPath, 'utf-8'));
        return ConfigSchema.parse(raw);
    }
    return ConfigSchema.parse({ version: 1 });
}

/**
 * Resolve a file path to absolute, read its content, and return metadata.
 */
async function resolveFile(filePath: string, cwd: string): Promise<{ absPath: string; relPath: string; content: string } | null> {
    const absPath = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
    if (!(await fs.pathExists(absPath))) {
        return null;
    }
    const content = await fs.readFile(absPath, 'utf-8');
    const relPath = path.relative(cwd, absPath);
    return { absPath, relPath, content };
}

/**
 * Run all fast gates on a single file's content.
 */
function checkFile(content: string, relPath: string, cwd: string, config: Config): FailureEntry[] {
    const failures: FailureEntry[] = [];
    const lines = content.split('\n');

    // Gate 1: File size
    const maxLines = config.gates.max_file_lines ?? 500;
    if (lines.length > maxLines) {
        failures.push({
            gate: 'file-size',
            file: relPath,
            message: `File has ${lines.length} lines (max: ${maxLines})`,
            severity: 'medium',
        });
    }

    const isJsTs = JS_TS_PATTERN.test(relPath);

    // Gate 2: Hallucinated imports (JS/TS only)
    if (isJsTs) {
        checkHallucinatedImports(content, relPath, cwd, failures);
    }

    // Gate 3: Promise safety (JS/TS only)
    if (isJsTs) {
        checkPromiseSafety(lines, relPath, failures);
    }

    // Gate 4: Security patterns (all languages)
    checkSecurityPatterns(lines, relPath, failures);

    return failures;
}

/**
 * Run fast gates on a set of files.
 * Returns structured JSON for hook consumers.
 */
export async function runHookChecker(options: CheckerOptions): Promise<HookCheckerResult> {
    const start = Date.now();
    const { cwd, files, timeout_ms = 5000 } = options;
    const failures: FailureEntry[] = [];

    try {
        const config = await loadConfig(cwd);
        const deadline = start + timeout_ms;

        for (const filePath of files) {
            if (Date.now() > deadline) {
                break;
            }

            const resolved = await resolveFile(filePath, cwd);
            if (!resolved) {
                continue;
            }

            const fileFailures = checkFile(resolved.content, resolved.relPath, cwd, config);
            failures.push(...fileFailures);
        }

        return {
            status: failures.length > 0 ? 'fail' : 'pass',
            failures,
            duration_ms: Date.now() - start,
        };

    } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
            status: 'error',
            failures: [{
                gate: 'hook-checker',
                file: '',
                message: `Hook checker error: ${msg}`,
                severity: 'medium',
            }],
            duration_ms: Date.now() - start,
        };
    }
}

/**
 * Check for imports of non-existent relative files.
 */
function checkHallucinatedImports(
    content: string,
    relPath: string,
    cwd: string,
    failures: FailureEntry[]
): void {
    const importRegex = /(?:import\s+.*\s+from\s+['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\))/g;
    let match: RegExpExecArray | null;

    while ((match = importRegex.exec(content)) !== null) {
        const specifier = match[1] || match[2];
        if (!specifier || !specifier.startsWith('.')) {
            continue;
        }

        const dir = path.dirname(path.join(cwd, relPath));
        const resolved = path.resolve(dir, specifier);

        const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs', '/index.ts', '/index.js'];
        const exists = extensions.some(ext => {
            try {
                return fs.existsSync(resolved + ext);
            } catch {
                return false;
            }
        });

        if (!exists) {
            const lineNum = content.substring(0, match.index).split('\n').length;
            failures.push({
                gate: 'hallucinated-imports',
                file: relPath,
                message: `Import '${specifier}' does not resolve to an existing file`,
                severity: 'high',
                line: lineNum,
            });
        }
    }
}

/**
 * Check for common async/promise safety issues.
 */
function checkPromiseSafety(
    lines: string[],
    relPath: string,
    failures: FailureEntry[]
): void {
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        checkUnsafeJsonParse(line, lines, i, relPath, failures);
        checkUnhandledFetch(line, lines, i, relPath, failures);
    }
}

function checkUnsafeJsonParse(
    line: string, lines: string[], i: number, relPath: string, failures: FailureEntry[]
): void {
    if (!/JSON\.parse\s*\(/.test(line)) {
        return;
    }
    const contextStart = Math.max(0, i - 5);
    const context = lines.slice(contextStart, i + 1).join('\n');
    if (!/try\s*\{/.test(context)) {
        failures.push({
            gate: 'promise-safety',
            file: relPath,
            message: 'JSON.parse() without try/catch — crashes on malformed input',
            severity: 'medium',
            line: i + 1,
        });
    }
}

function checkUnhandledFetch(
    line: string, lines: string[], i: number, relPath: string, failures: FailureEntry[]
): void {
    if (!/\bfetch\s*\(/.test(line) || /\.catch\b/.test(line) || /await/.test(line)) {
        return;
    }
    const contextEnd = Math.min(lines.length, i + 3);
    const afterContext = lines.slice(i, contextEnd).join('\n');
    const beforeContext = lines.slice(Math.max(0, i - 5), i + 1).join('\n');
    if (!/\.catch\b/.test(afterContext) && !/try\s*\{/.test(beforeContext)) {
        failures.push({
            gate: 'promise-safety',
            file: relPath,
            message: 'fetch() without error handling',
            severity: 'medium',
            line: i + 1,
        });
    }
}

/**
 * Check for critical security patterns.
 */
function checkSecurityPatterns(
    lines: string[],
    relPath: string,
    failures: FailureEntry[]
): void {
    const isTestFile = /\.(test|spec|example|mock)\./i.test(relPath);

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        checkHardcodedSecrets(line, i, relPath, isTestFile, failures);
        checkCommandInjection(line, i, relPath, failures);
    }
}

function checkHardcodedSecrets(
    line: string, i: number, relPath: string, isTestFile: boolean, failures: FailureEntry[]
): void {
    if (isTestFile) {
        return;
    }
    if (/(?:api[_-]?key|secret|password|token)\s*[:=]\s*['"][A-Za-z0-9+/=]{20,}['"]/i.test(line)) {
        failures.push({
            gate: 'security-patterns',
            file: relPath,
            message: 'Possible hardcoded secret or API key',
            severity: 'critical',
            line: i + 1,
        });
    }
}

function checkCommandInjection(
    line: string, i: number, relPath: string, failures: FailureEntry[]
): void {
    if (/(?:exec|spawn|execSync|spawnSync)\s*\(.*\$\{/.test(line)) {
        failures.push({
            gate: 'security-patterns',
            file: relPath,
            message: 'Potential command injection: user input in shell command',
            severity: 'critical',
            line: i + 1,
        });
    }
}
