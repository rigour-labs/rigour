/**
 * Lightweight per-file checker for hook integration.
 *
 * Runs a fast subset of Rigour gates on individual files,
 * designed to complete in <200ms for real-time hook feedback.
 *
 * Used by all tool-specific hooks (Claude, Cursor, Cline, Windsurf).
 *
 */

import fs from 'fs-extra';
import path from 'path';
import yaml from 'yaml';
import { ConfigSchema, Config } from '../types/index.js';
import { codeOffsets } from '../utils/code-mask.js';
import { resolveTsPathTarget } from '../gates/hallucinated-imports/ts-path-target.js';
import type { HookCheckerResult } from './types.js';
import { scanInputForCredentials } from './input-validator.js';
import { evaluateWriteScope, loadAgentScopesFromDisk } from '../firewall/scope-enforcement.js';

type FailureEntry = HookCheckerResult['failures'][number];

export interface CheckerOptions {
    cwd: string;
    files: string[];
    timeout_ms?: number;
    block_on_failure?: boolean;
    /** Bound writer identity — required when agent scopes are registered */
    agentId?: string;
}

const JS_TS_PATTERN = /\.(ts|tsx|js|jsx|mts|mjs)$/;

/**
 * Check if a file matches any ignore pattern from rigour.yml.
 */
function isIgnored(relPath: string, patterns: string[]): boolean {
    const normalized = relPath.replace(/\\/g, '/');
    return patterns.some(pattern => {
        const clean = pattern.replace(/\\/g, '/');
        if (normalized === clean) return true;
        // Glob: foo/** matches foo/bar/baz
        const prefix = clean.replace('/**', '').replace('/*', '');
        if (prefix !== clean) {
            return normalized.startsWith(prefix + '/') || normalized === prefix;
        }
        return false;
    });
}

/**
 * Load rigour config from cwd, falling back to defaults.
 */
async function loadConfig(cwd: string): Promise<Config> {
    const configPath = path.join(cwd, 'rigour.yml');
    if (await fs.pathExists(configPath)) {
        const raw = yaml.parse(await fs.readFile(configPath, 'utf-8'));
        return ConfigSchema.parse(raw);
    }
    return ConfigSchema.parse({});
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
async function checkFile(content: string, relPath: string, cwd: string, config: Config): Promise<FailureEntry[]> {
    const failures: FailureEntry[] = [];
    const lines = content.split('\n');

    // Gate 0a: Protected paths — BLOCK writes to .github/, rigour.yml, etc.
    checkProtectedPaths(relPath, config, failures);

    // Gate 0b: Memory & Skills Governance — block writes to agent-native memory paths
    checkGovernance(content, relPath, config, failures);

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
        await checkHallucinatedImports(content, relPath, cwd, failures);
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
    const { cwd, files, timeout_ms = 5000, agentId } = options;
    const failures: FailureEntry[] = [];
    let timedOut = false;

    try {
        const config = await loadConfig(cwd);
        const deadline = start + timeout_ms;

        const ignorePatterns = config.ignore ?? [];
        const agentScopes = await loadAgentScopesFromDisk(cwd);

        for (const filePath of files) {
            if (Date.now() > deadline) {
                timedOut = true;
                break;
            }

            const resolved = await resolveFile(filePath, cwd);
            if (!resolved) {
                continue;
            }

            // Before ignore patterns: rigour.yml commonly ignores .rigour/ for scanning, not for writes.
            if (isRigourState(resolved.relPath)) {
                failures.push(rigourStateFailure(resolved.relPath));
                continue;
            }

            // Respect rigour.yml ignore patterns
            if (isIgnored(resolved.relPath, ignorePatterns)) {
                continue;
            }

            if (agentScopes.length > 0) {
                const scopeEv = evaluateWriteScope(cwd, resolved.relPath, agentScopes, agentId);
                if (scopeEv.decision !== 'allow') {
                    failures.push({
                        gate: 'agent-scope',
                        file: resolved.relPath,
                        message: scopeEv.reason,
                        severity: 'critical',
                    });
                    continue;
                }
            }

            const fileFailures = await checkFile(resolved.content, resolved.relPath, cwd, config);
            failures.push(...fileFailures);
        }

        if (timedOut) {
            failures.push({
                gate: 'hook-timeout',
                file: '',
                message: `Hook checker exceeded ${timeout_ms}ms before all files were scanned (fail-closed)`,
                severity: 'critical',
            });
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
 * Check for imports of non-existent relative files, resolved by the same rule as the review's hallucinated-imports gate
 * (ts-path-target.ts): an extensionless path with any source extension or as a folder's index, and a TypeScript ESM
 * specifier naming the emitted file (`./b.js` for `b.ts` or `b.tsx`, `.mjs` for `.mts`, `.cjs` for `.cts`).
 */
async function checkHallucinatedImports(
    content: string,
    relPath: string,
    cwd: string,
    failures: FailureEntry[]
): Promise<void> {
    const importRegex = /(?:import\s+.*\s+from\s+['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\))/g;
    // An import written inside a string (a template, a fixture) or a comment is text, not an import.
    const isCode = codeOffsets(content, path.extname(relPath).slice(1));
    let match: RegExpExecArray | null;

    while ((match = importRegex.exec(content)) !== null) {
        if (!isCode(match.index)) continue;
        const specifier = match[1] || match[2];
        if (!specifier || !specifier.startsWith('.')) {
            continue;
        }

        const dir = path.dirname(path.join(cwd, relPath));
        if (!await resolveTsPathTarget(dir, specifier, cwd, new Set())) {
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
    if (!isTestFile) checkVendorKeys(lines.join('\n'), relPath, failures);
}

/** Credential formats a vendor issues: unambiguous in code, unlike entropy or variable-name guesses. */
const VENDOR_KEYS = new Set(['aws_access_key', 'openai_key', 'anthropic_key', 'github_token', 'stripe_key', 'slack_token', 'sendgrid_key', 'private_key', 'private_key_full']);

/** A real vendor key written into code, whatever the variable is called. */
function checkVendorKeys(content: string, relPath: string, failures: FailureEntry[]): void {
    for (const detection of scanInputForCredentials(content).detections) {
        if (!VENDOR_KEYS.has(detection.type) || !detection.position) continue;
        const raw = content.slice(detection.position.start, detection.position.end);
        if (/^pk_|_test_/.test(raw)) continue; // publishable and test keys are meant to be shared
        const line = content.slice(0, detection.position.start).split('\n').length;
        if (failures.some(f => f.gate === 'security-patterns' && f.line === line)) continue;
        failures.push({ gate: 'security-patterns', file: relPath, message: `${detection.description} in code`, severity: 'critical', line });
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

// ── Rigour's own state (always on) ────────────────────────────────

/**
 * .rigour/ holds what decides a review: dismissals, check outcomes, learned rules, the review
 * ledger, operator scopes. Rigour writes it through its own commands and tools, never through
 * the agent's edit tool, so an agent edit there is refused whatever rigour.yml says.
 */
function isRigourState(relPath: string): boolean {
    return relPath.replace(/\\/g, '/').startsWith('.rigour/');
}

function rigourStateFailure(relPath: string): FailureEntry {
    return {
        gate: 'file-guard',
        file: relPath,
        message: `BLOCKED: "${relPath}" is Rigour's own state. Change it with Rigour's commands (rigour dismiss, rigour_review_ack, rigour_remember), not by editing the file.`,
        severity: 'critical',
    };
}

// ── Protected Paths Enforcement (real-time) ───────────────────────

/**
 * Block writes to protected paths defined in rigour.yml safety.protected_paths.
 * This runs in real-time via hooks — BEFORE the agent commits the write.
 */
function checkProtectedPaths(
    relPath: string,
    config: Config,
    failures: FailureEntry[]
): void {
    const protectedPaths = config.gates.safety?.protected_paths ?? [];
    if (protectedPaths.length === 0) return;

    const normalizedPath = relPath.replace(/\\/g, '/');

    const matched = protectedPaths.find(pattern => {
        const clean = pattern.replace('/**', '').replace('/*', '');
        if (normalizedPath === clean) return true;
        if (clean.endsWith('/')) return normalizedPath.startsWith(clean);
        return normalizedPath.startsWith(clean + '/');
    });

    if (matched) {
        failures.push({
            gate: 'file-guard',
            file: relPath,
            message: `BLOCKED: Agent cannot write to protected path "${relPath}" (matches ${matched}). CI/CD, docs, and config files require human review.`,
            severity: 'critical',
        });
    }
}

// ── Memory & Skills Governance (v4.2+) ────────────────────────────

/**
 * Simple glob matcher — handles exact paths, `*` (single segment),
 * and `**` (any depth). No external dependencies.
 */
function simpleGlob(filePath: string, pattern: string): boolean {
    // Exact match
    if (filePath === pattern) return true;

    // Convert glob to regex: ** → any path, * → single segment
    const regexStr = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex specials (except * and ?)
        .replace(/\*\*/g, '<<<DOUBLESTAR>>>')
        .replace(/\*/g, '[^/]*')
        .replace(/<<<DOUBLESTAR>>>/g, '.*');

    return new RegExp(`^${regexStr}$`).test(filePath);
}

/**
 * Intercept writes to agent-native memory AND skills files.
 *
 * Two separate enforcement layers:
 *   1. enforce_memory — blocks writes to CLAUDE.md, .clinerules, .windsurf/memories/
 *      → tells agent: "use rigour_remember instead"
 *   2. enforce_skills — blocks writes to .claude/skills/, .cursor/rules/, etc.
 *      → tells agent: "use rigour skills system instead"
 *
 * Both layers DLP-scan content for credentials regardless of blocking.
 *
 * Users can disable via rigour.yml:
 *   gates:
 *     governance:
 *       enabled: false          # disable everything
 *       enforce_memory: false   # allow native memory, still enforce skills
 *       enforce_skills: false   # allow native skills, still enforce memory
 *
 */
function checkGovernance(
    content: string,
    relPath: string,
    config: Config,
    failures: FailureEntry[]
): void {
    const gov = config.gates.governance;
    if (!gov?.enabled) return;

    const exemptPaths = gov.exempt_paths ?? [];
    const normalizedPath = relPath.replace(/\\/g, '/');

    // Check exemptions first (Rigour's own hook configs)
    const isExempt = exemptPaths.some(pattern =>
        simpleGlob(normalizedPath, pattern)
    );
    if (isExempt) return;

    // ── Check memory paths ──
    const memoryPaths = gov.protected_memory_paths ?? [];
    const isMemoryPath = memoryPaths.some(pattern =>
        simpleGlob(normalizedPath, pattern)
    );

    // ── Check skills paths ──
    const skillsPaths = gov.protected_skills_paths ?? [];
    const isSkillsPath = skillsPaths.some(pattern =>
        simpleGlob(normalizedPath, pattern)
    );

    if (!isMemoryPath && !isSkillsPath) return;

    // ── Enforcement: block memory writes ──
    if (isMemoryPath && gov.enforce_memory && gov.block_native_memory) {
        failures.push({
            gate: 'governance',
            file: relPath,
            message: `BLOCKED: Agent writing to native memory path "${relPath}". Use rigour_remember instead — it DLP-scans and persists safely to .rigour/memory.json`,
            severity: 'critical',
        });
    }

    // ── Enforcement: block skills writes ──
    if (isSkillsPath && gov.enforce_skills) {
        failures.push({
            gate: 'governance-skills',
            file: relPath,
            message: `BLOCKED: Agent writing to native skills/rules path "${relPath}". Use Rigour skills system instead — governed, DLP-scanned, and auditable`,
            severity: 'critical',
        });
    }

    // ── DLP scan the content being written (always, regardless of block settings) ──
    const dlpResult = scanInputForCredentials(content);
    if (dlpResult.status !== 'clean') {
        for (const detection of dlpResult.detections) {
            failures.push({
                gate: 'governance-dlp',
                file: relPath,
                message: `${detection.description} found in agent ${isMemoryPath ? 'memory' : 'skills'} file. ${detection.recommendation}`,
                severity: detection.severity === 'critical' ? 'critical' : 'high',
            });
        }
    }
}
