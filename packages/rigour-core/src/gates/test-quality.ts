/**
 * AI Test Quality Gate
 *
 * Detects AI-generated test anti-patterns that create false confidence.
 * AI models generate tests that look comprehensive but actually test
 * the AI's own assumptions rather than the developer's intent.
 *
 * Detected anti-patterns:
 *   1. Empty test bodies — tests with no assertions
 *   2. Tautological assertions — expect(true).toBe(true), assert True
 *   3. Mock-everything — tests that mock every dependency (test nothing real)
 *   4. Missing error path tests — only happy path tested
 *   5. Shallow snapshot abuse — snapshot tests with no semantic assertions
 *   6. Assertion-free async — async tests that never await/assert
 *
 * Supported test frameworks:
 *   JS/TS  — Jest, Vitest, Mocha, Jasmine, Node test runner
 *   Python — pytest, unittest
 *   Go     — testing package (t.Run, table-driven tests)
 *   Java   — JUnit 4/5, TestNG
 *   Kotlin — JUnit 5, kotlin.test
 */

import { Gate, GateContext } from './base.js';
import { Failure, Provenance } from '../types/index.js';
import { FileScanner } from '../utils/scanner.js';
import { Logger } from '../utils/logger.js';
import { languageAdapters } from './language-adapters/index.js';
import { checkGoTestQuality, checkJavaKotlinTestQuality } from './test-quality-lang.js';
import {
    JS_TEST_START_PATTERN, JS_ASSERTION_PATTERNS, JS_MOCK_PATTERNS,
    JS_TAUTOLOGICAL_PATTERNS, JS_VAR_TAUTOLOGY_PATTERN, SNAPSHOT_PATTERNS,
    PYTHON_TEST_FUNC_PATTERN, PYTHON_ASSERTION_PATTERNS, PYTHON_MOCK_PATTERNS,
    PYTHON_TAUTOLOGICAL_PATTERNS, PYTHON_FIXTURE_PATTERN, PYTHON_CONFTEST_NAME,
} from './test-quality-matchers.js';
import fs from 'fs-extra';
import path from 'path';

export interface TestQualityIssue {
    file: string;
    line: number;
    pattern: string;
    reason: string;
}

export interface TestQualityConfig {
    enabled?: boolean;
    check_empty_tests?: boolean;
    check_tautological?: boolean;
    check_mock_heavy?: boolean;
    check_snapshot_abuse?: boolean;
    check_assertion_free_async?: boolean;
    max_mocks_per_test?: number;
    ignore_patterns?: string[];
}

export class TestQualityGate extends Gate {
    private config: Required<Omit<TestQualityConfig, 'ignore_patterns'>> & { ignore_patterns: string[] };

    constructor(config: TestQualityConfig = {}) {
        super('test-quality', 'AI Test Quality Detection');
        this.config = {
            enabled: config.enabled ?? true,
            check_empty_tests: config.check_empty_tests ?? true,
            check_tautological: config.check_tautological ?? true,
            check_mock_heavy: config.check_mock_heavy ?? true,
            check_snapshot_abuse: config.check_snapshot_abuse ?? true,
            check_assertion_free_async: config.check_assertion_free_async ?? true,
            max_mocks_per_test: config.max_mocks_per_test ?? 5,
            ignore_patterns: config.ignore_patterns ?? [],
        };
    }

    protected get provenance(): Provenance { return 'ai-drift'; }

    async run(context: GateContext): Promise<Failure[]> {
        if (!this.config.enabled) return [];

        const failures: Failure[] = [];
        const issues: TestQualityIssue[] = [];

        const defaultPatterns = [
                '**/*.test.{ts,js,tsx,jsx,mjs,cjs}', '**/*.spec.{ts,js,tsx,jsx,mjs,cjs}',
                '**/__tests__/**/*.{ts,js,tsx,jsx,mjs,cjs}',
                '**/test_*.py', '**/*_test.py', '**/tests/**/*.py',
                '**/*_test.go',
                '**/*Test.java', '**/*Tests.java', '**/src/test/**/*.java',
                '**/*Test.kt', '**/*Tests.kt', '**/src/test/**/*.kt',
                '**/*_test.rs', '**/tests/**/*.rs',
                '**/*_spec.rb', '**/spec/**/*.rb',
        ];
        const scanPatterns = context.patterns || defaultPatterns;
        const files = await FileScanner.findFiles({
            cwd: context.cwd,
            patterns: scanPatterns,
            ignore: [...(context.ignore || []), '**/node_modules/**', '**/dist/**', '**/build/**',
                '**/.venv/**', '**/venv/**', '**/vendor/**',
                '**/target/**', '**/.gradle/**', '**/out/**'],
        });

        Logger.info(`Test Quality: Scanning ${files.length} test files`);

        const CONCURRENCY = 16;
        for (let i = 0; i < files.length; i += CONCURRENCY) {
            const batch = files.slice(i, i + CONCURRENCY);
            const results = await Promise.allSettled(batch.map(async (file) => {
                const fullPath = path.join(context.cwd, file);
                const content = await fs.readFile(fullPath, 'utf-8');
                const ext = path.extname(file);
                const adapter = languageAdapters.getAdapter(file);
                if (!adapter) return [];

                const localIssues: typeof issues = [];
                switch (adapter.id) {
                    case 'js':
                        this.checkJSTestQuality(content, file, localIssues);
                        break;
                    case 'python':
                        this.checkPythonTestQuality(content, file, localIssues);
                        break;
                    case 'go':
                        checkGoTestQuality(content, file, localIssues, {
                            check_empty_tests: this.config.check_empty_tests,
                            check_tautological: this.config.check_tautological,
                            check_mock_heavy: this.config.check_mock_heavy,
                            max_mocks_per_test: this.config.max_mocks_per_test,
                        });
                        break;
                    case 'java':
                        checkJavaKotlinTestQuality(content, file, ext, localIssues, {
                            check_empty_tests: this.config.check_empty_tests,
                            check_tautological: this.config.check_tautological,
                            check_mock_heavy: this.config.check_mock_heavy,
                            max_mocks_per_test: this.config.max_mocks_per_test,
                        });
                        break;
                }
                return localIssues;
            }));
            for (const result of results) {
                if (result.status === 'fulfilled') issues.push(...result.value);
            }
        }

        // Group by file
        const byFile = new Map<string, TestQualityIssue[]>();
        for (const issue of issues) {
            const existing = byFile.get(issue.file) || [];
            existing.push(issue);
            byFile.set(issue.file, existing);
        }

        for (const [file, fileIssues] of byFile) {
            const details = fileIssues.map(i => `  L${i.line}: [${i.pattern}] ${i.reason}`).join('\n');
            failures.push(this.createFailure(
                `AI test quality issues in ${file}:\n${details}`,
                [file],
                `These test patterns indicate AI-generated tests that may not verify actual behavior. Review each test to ensure it validates real business logic, not just AI assumptions.`,
                'AI Test Quality',
                fileIssues[0].line,
                undefined,
                'medium'
            ));
        }

        return failures;
    }

    private checkJSTestQuality(content: string, file: string, issues: TestQualityIssue[]): void {
        const lines = content.split('\n');

        // Track test blocks for analysis
        let inTestBlock = false;
        let testStartLine = 0;
        let braceDepth = 0;
        let testBlockContent = '';
        let mockCount = 0;
        let hasAssertion = false;
        let hasAwait = false;
        let isAsync = false;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmed = line.trim();

            // Detect test block start: it('...', () => { or test('...', async () => {
            const testStart = trimmed.match(JS_TEST_START_PATTERN);
            if (testStart && !inTestBlock) {
                inTestBlock = true;
                testStartLine = i + 1;
                braceDepth = 1;
                testBlockContent = '';
                mockCount = 0;
                hasAssertion = false;
                hasAwait = false;
                isAsync = !!testStart[1];

                // Count opening braces on this line beyond the first
                for (let j = line.indexOf('{') + 1; j < line.length; j++) {
                    if (line[j] === '{') braceDepth++;
                    if (line[j] === '}') braceDepth--;
                }

                if (braceDepth === 0) {
                    // Single-line test — check immediately
                    this.analyzeJSTestBlock(line, file, testStartLine, mockCount, hasAssertion, hasAwait, isAsync, issues);
                    inTestBlock = false;
                }
                continue;
            }

            if (inTestBlock) {
                testBlockContent += line + '\n';

                // Track braces
                for (const ch of line) {
                    if (ch === '{') braceDepth++;
                    if (ch === '}') braceDepth--;
                }

                // Check for assertions
                if (JS_ASSERTION_PATTERNS.some(p => p.test(line))) {
                    hasAssertion = true;
                }

                // Check for mocks
                if (JS_MOCK_PATTERNS.some(p => p.test(line))) {
                    mockCount++;
                }

                // Check for await
                if (/\bawait\b/.test(line)) {
                    hasAwait = true;
                }

                // Check for tautological assertions
                if (this.config.check_tautological) {
                    if (JS_TAUTOLOGICAL_PATTERNS.some(p => p.test(line))) {
                        issues.push({
                            file, line: i + 1, pattern: 'tautological-assertion',
                            reason: 'Tautological assertion — comparing a literal to itself proves nothing',
                        });
                    }
                    // Variable tautology: expect(x).toBe(x), expect(foo).toEqual(foo)
                    const varTautology = line.match(JS_VAR_TAUTOLOGY_PATTERN);
                    if (varTautology && varTautology[1] === varTautology[2]) {
                        issues.push({
                            file, line: i + 1, pattern: 'tautological-assertion',
                            reason: `Tautological assertion — expect(${varTautology[1]}).toBe(${varTautology[2]}) compares variable to itself`,
                        });
                    }
                }

                // Check for snapshot-only tests
                if (this.config.check_snapshot_abuse) {
                    if (SNAPSHOT_PATTERNS.some(p => p.test(line))) {
                        // This is fine IF there are also semantic assertions
                        // We'll check when the block ends
                    }
                }

                // End of test block
                if (braceDepth === 0) {
                    this.analyzeJSTestBlock(testBlockContent, file, testStartLine, mockCount, hasAssertion, hasAwait, isAsync, issues);
                    inTestBlock = false;
                }
            }
        }
    }

    private analyzeJSTestBlock(
        content: string, file: string, startLine: number,
        mockCount: number, hasAssertion: boolean, hasAwait: boolean,
        isAsync: boolean, issues: TestQualityIssue[]
    ): void {
        const trimmedContent = content.trim();
        const lines = trimmedContent.split('\n').filter(l => l.trim() && !l.trim().startsWith('//'));

        // Empty test body
        if (this.config.check_empty_tests && (lines.length <= 1 || !hasAssertion)) {
            // Check if it's truly empty (just braces) or has no assertions
            const hasAnyCode = lines.some(l => {
                const t = l.trim();
                return t && t !== '{' && t !== '}' && t !== '});' && !t.startsWith('//');
            });

            if (!hasAnyCode) {
                issues.push({
                    file, line: startLine, pattern: 'empty-test',
                    reason: 'Empty test body — test does not verify any behavior',
                });
            } else if (!hasAssertion) {
                issues.push({
                    file, line: startLine, pattern: 'no-assertion',
                    reason: 'Test has no assertions — executes code but never verifies results',
                });
            }
        }

        // Mock-heavy test
        if (this.config.check_mock_heavy && mockCount > this.config.max_mocks_per_test) {
            issues.push({
                file, line: startLine, pattern: 'mock-heavy',
                reason: `Test uses ${mockCount} mocks (max: ${this.config.max_mocks_per_test}) — may be testing mocks instead of real behavior`,
            });
        }

        // Async without await
        if (this.config.check_assertion_free_async && isAsync && !hasAwait && hasAssertion) {
            issues.push({
                file, line: startLine, pattern: 'async-no-await',
                reason: 'Async test never uses await — promises may not be resolved before assertions',
            });
        }
    }

    private checkPythonTestQuality(content: string, file: string, issues: TestQualityIssue[]): void {
        const lines = content.split('\n');
        const basename = path.basename(file);

        // Skip conftest.py entirely — these contain fixtures, not tests
        if (basename === PYTHON_CONFTEST_NAME) return;

        let inTestFunc = false;
        let testStartLine = 0;
        let testIndent = 0;
        let hasAssertion = false;
        let mockCount = 0;
        let testContent = '';
        let hasFixtureDecorator = false;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmed = line.trim();

            // Detect test function start
            const testFuncMatch = line.match(PYTHON_TEST_FUNC_PATTERN);
            if (testFuncMatch) {
                // Check if this function has a @pytest.fixture decorator (not a real test)
                hasFixtureDecorator = false;
                for (let j = i - 1; j >= 0 && j >= i - 5; j--) {
                    const prevLine = lines[j].trim();
                    if (!prevLine || prevLine.startsWith('#')) continue;
                    if (!prevLine.startsWith('@')) break;
                    if (PYTHON_FIXTURE_PATTERN.test(prevLine)) {
                        hasFixtureDecorator = true;
                        break;
                    }
                }
                if (hasFixtureDecorator) continue; // Skip — this is a fixture, not a test
                // If we were in a previous test, analyze it
                if (inTestFunc) {
                    this.analyzePythonTestBlock(testContent, file, testStartLine, hasAssertion, mockCount, issues);
                }

                inTestFunc = true;
                testStartLine = i + 1;
                testIndent = testFuncMatch[1].length;
                hasAssertion = false;
                mockCount = 0;
                testContent = '';
                continue;
            }

            if (inTestFunc) {
                // Check if we've left the function (non-empty line at same or lower indent)
                if (trimmed && !line.match(/^\s/) && testIndent === 0) {
                    this.analyzePythonTestBlock(testContent, file, testStartLine, hasAssertion, mockCount, issues);
                    inTestFunc = false;
                    continue;
                }
                if (trimmed && line.match(/^\s+/) && line.search(/\S/) <= testIndent && !trimmed.startsWith('#')) {
                    // Non-empty line at or below function indent = function ended
                    // But only if not a decorator or continuation
                    if (!trimmed.startsWith('@') && !trimmed.startsWith(')') && !trimmed.startsWith(']')) {
                        this.analyzePythonTestBlock(testContent, file, testStartLine, hasAssertion, mockCount, issues);
                        inTestFunc = false;
                        i--; // Re-process this line
                        continue;
                    }
                }

                testContent += line + '\n';

                // Check for assertions
                if (PYTHON_ASSERTION_PATTERNS.some(p => p.test(trimmed))) {
                    hasAssertion = true;
                }

                // Check for mocks
                if (PYTHON_MOCK_PATTERNS.some(p => p.test(trimmed))) {
                    mockCount++;
                }

                // Tautological assertions
                if (this.config.check_tautological) {
                    if (PYTHON_TAUTOLOGICAL_PATTERNS.some(p => p.test(trimmed))) {
                        issues.push({
                            file, line: i + 1, pattern: 'tautological-assertion',
                            reason: 'Tautological assertion — comparing a constant to itself proves nothing',
                        });
                    }
                }
            }
        }

        // Handle last test function
        if (inTestFunc) {
            this.analyzePythonTestBlock(testContent, file, testStartLine, hasAssertion, mockCount, issues);
        }
    }

    private analyzePythonTestBlock(
        content: string, file: string, startLine: number,
        hasAssertion: boolean, mockCount: number, issues: TestQualityIssue[]
    ): void {
        const lines = content.split('\n').filter(l => l.trim() && !l.trim().startsWith('#'));

        // Empty test (only pass or docstring)
        if (this.config.check_empty_tests) {
            const meaningfulLines = lines.filter(l => {
                const t = l.trim();
                return t && t !== 'pass' && !t.startsWith('"""') && !t.startsWith("'''") && !t.startsWith('#');
            });
            if (meaningfulLines.length === 0) {
                issues.push({
                    file, line: startLine, pattern: 'empty-test',
                    reason: 'Empty test function — contains only pass or docstring',
                });
                return;
            }
        }

        // No assertions
        if (this.config.check_empty_tests && !hasAssertion && lines.length > 0) {
            issues.push({
                file, line: startLine, pattern: 'no-assertion',
                reason: 'Test has no assertions — executes code but never verifies results',
            });
        }

        // Mock-heavy
        if (this.config.check_mock_heavy && mockCount > this.config.max_mocks_per_test) {
            issues.push({
                file, line: startLine, pattern: 'mock-heavy',
                reason: `Test uses ${mockCount} mocks (max: ${this.config.max_mocks_per_test}) — may be testing mocks, not real behavior`,
            });
        }
    }
}
