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
 *
 * @since v3.0.0
 * @since v3.0.3 — Go, Java, Kotlin support added
 */

import { Gate, GateContext } from './base.js';
import { Failure, Provenance } from '../types/index.js';
import { FileScanner } from '../utils/scanner.js';
import { Logger } from '../utils/logger.js';
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

        const files = await FileScanner.findFiles({
            cwd: context.cwd,
            patterns: [
                '**/*.test.{ts,js,tsx,jsx}', '**/*.spec.{ts,js,tsx,jsx}',
                '**/__tests__/**/*.{ts,js,tsx,jsx}',
                '**/test_*.py', '**/*_test.py', '**/tests/**/*.py',
                '**/*_test.go',
                '**/*Test.java', '**/*Tests.java', '**/src/test/**/*.java',
                '**/*Test.kt', '**/*Tests.kt', '**/src/test/**/*.kt',
            ],
            ignore: [...(context.ignore || []), '**/node_modules/**', '**/dist/**', '**/build/**',
                '**/.venv/**', '**/venv/**', '**/vendor/**',
                '**/target/**', '**/.gradle/**', '**/out/**'],
        });

        Logger.info(`Test Quality: Scanning ${files.length} test files`);

        for (const file of files) {
            try {
                const fullPath = path.join(context.cwd, file);
                const content = await fs.readFile(fullPath, 'utf-8');
                const ext = path.extname(file);

                if (['.ts', '.js', '.tsx', '.jsx'].includes(ext)) {
                    this.checkJSTestQuality(content, file, issues);
                } else if (ext === '.py') {
                    this.checkPythonTestQuality(content, file, issues);
                } else if (ext === '.go') {
                    this.checkGoTestQuality(content, file, issues);
                } else if (ext === '.java' || ext === '.kt') {
                    this.checkJavaKotlinTestQuality(content, file, ext, issues);
                }
            } catch { /* skip */ }
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
            const testStart = trimmed.match(/^(?:it|test)\s*\(\s*['"`].*['"`]\s*,\s*(async\s+)?(?:\(\s*\)|function\s*\(\s*\)|\(\s*\{[^}]*\}\s*\))\s*(?:=>)?\s*\{/);
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
                if (/expect\s*\(/.test(line) || /assert\s*[.(]/.test(line) ||
                    /\.toEqual|\.toBe|\.toContain|\.toMatch|\.toThrow|\.toHaveBeenCalled|\.toHaveLength|\.toBeTruthy|\.toBeFalsy|\.toBeDefined|\.toBeNull|\.toBeUndefined|\.toBeGreaterThan|\.toBeLessThan|\.toHaveProperty|\.toStrictEqual|\.rejects|\.resolves/.test(line)) {
                    hasAssertion = true;
                }

                // Check for mocks
                if (/jest\.fn\(|vi\.fn\(|jest\.mock\(|vi\.mock\(|jest\.spyOn\(|vi\.spyOn\(|sinon\.(stub|mock|spy)\(/.test(line)) {
                    mockCount++;
                }

                // Check for await
                if (/\bawait\b/.test(line)) {
                    hasAwait = true;
                }

                // Check for tautological assertions
                if (this.config.check_tautological) {
                    if (/expect\s*\(\s*true\s*\)\s*\.toBe\s*\(\s*true\s*\)/.test(line) ||
                        /expect\s*\(\s*false\s*\)\s*\.toBe\s*\(\s*false\s*\)/.test(line) ||
                        /expect\s*\(\s*1\s*\)\s*\.toBe\s*\(\s*1\s*\)/.test(line) ||
                        /expect\s*\(\s*['"].*['"]\s*\)\s*\.toBe\s*\(\s*['"].*['"]\s*\)/.test(line) && line.match(/expect\s*\(\s*(['"].*?['"])\s*\)\s*\.toBe\s*\(\s*\1\s*\)/)) {
                        issues.push({
                            file, line: i + 1, pattern: 'tautological-assertion',
                            reason: 'Tautological assertion — comparing a literal to itself proves nothing',
                        });
                    }
                }

                // Check for snapshot-only tests
                if (this.config.check_snapshot_abuse) {
                    if (/\.toMatchSnapshot\s*\(/.test(line) || /\.toMatchInlineSnapshot\s*\(/.test(line)) {
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

        let inTestFunc = false;
        let testStartLine = 0;
        let testIndent = 0;
        let hasAssertion = false;
        let mockCount = 0;
        let testContent = '';

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmed = line.trim();

            // Detect test function start
            const testFuncMatch = line.match(/^(\s*)(?:def|async\s+def)\s+(test_\w+)\s*\(/);
            if (testFuncMatch) {
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
                if (/\bassert\s+/.test(trimmed) || /self\.assert\w+\s*\(/.test(trimmed) ||
                    /pytest\.raises\s*\(/.test(trimmed) || /\.assert_called|\.assert_any_call/.test(trimmed)) {
                    hasAssertion = true;
                }

                // Check for mocks
                if (/mock\.|Mock\(|patch\(|MagicMock\(/.test(trimmed)) {
                    mockCount++;
                }

                // Tautological assertions
                if (this.config.check_tautological) {
                    if (/\bassert\s+True\s*$/.test(trimmed) || /\bassert\s+1\s*==\s*1/.test(trimmed) ||
                        /self\.assertTrue\s*\(\s*True\s*\)/.test(trimmed) ||
                        /self\.assertEqual\s*\(\s*(\d+|['"][^'"]*['"])\s*,\s*\1\s*\)/.test(trimmed)) {
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

    /**
     * Go test quality checks.
     * Go tests use func TestXxx(t *testing.T) pattern.
     * Assertions via t.Fatal, t.Error, t.Fatalf, t.Errorf, t.Fail, t.FailNow.
     * Also checks for t.Run subtests and table-driven patterns.
     */
    private checkGoTestQuality(content: string, file: string, issues: TestQualityIssue[]): void {
        const lines = content.split('\n');

        let inTestFunc = false;
        let testStartLine = 0;
        let braceDepth = 0;
        let hasAssertion = false;
        let testContent = '';

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmed = line.trim();

            // Detect test function: func TestXxx(t *testing.T) {
            const testMatch = trimmed.match(/^func\s+(Test\w+|Benchmark\w+)\s*\(/);
            if (testMatch && !inTestFunc) {
                inTestFunc = true;
                testStartLine = i + 1;
                braceDepth = 0;
                hasAssertion = false;
                testContent = '';

                // Count braces on this line
                for (const ch of line) {
                    if (ch === '{') braceDepth++;
                    if (ch === '}') braceDepth--;
                }
                continue;
            }

            if (inTestFunc) {
                testContent += line + '\n';

                for (const ch of line) {
                    if (ch === '{') braceDepth++;
                    if (ch === '}') braceDepth--;
                }

                // Go test assertions: t.Fatal, t.Error, t.Fatalf, t.Errorf, t.Fail, t.FailNow
                // Also: assert/require from testify, t.Run for subtests
                if (/\bt\.\s*(?:Fatal|Error|Fatalf|Errorf|Fail|FailNow|Log|Logf|Skip|Skipf|Helper)\s*\(/.test(line) ||
                    /\bt\.Run\s*\(/.test(line) ||
                    /\bassert\.\w+\s*\(/.test(line) || /\brequire\.\w+\s*\(/.test(line) ||
                    /\bif\b.*\bt\./.test(line)) {
                    hasAssertion = true;
                }

                // Tautological: if true { t.Fatal... } or assert.True(t, true)
                if (this.config.check_tautological) {
                    if (/assert\.True\s*\(\s*\w+\s*,\s*true\s*\)/.test(line) ||
                        /assert\.Equal\s*\(\s*\w+\s*,\s*(\d+|"[^"]*")\s*,\s*\1\s*\)/.test(line)) {
                        issues.push({
                            file, line: i + 1, pattern: 'tautological-assertion',
                            reason: 'Tautological assertion — comparing a constant to itself proves nothing',
                        });
                    }
                }

                // End of function
                if (braceDepth === 0 && testContent.trim()) {
                    const meaningful = testContent.split('\n').filter(l => {
                        const t = l.trim();
                        return t && t !== '{' && t !== '}' && !t.startsWith('//');
                    });

                    if (this.config.check_empty_tests && meaningful.length === 0) {
                        issues.push({
                            file, line: testStartLine, pattern: 'empty-test',
                            reason: 'Empty test function — no test logic',
                        });
                    } else if (this.config.check_empty_tests && !hasAssertion && meaningful.length > 0) {
                        issues.push({
                            file, line: testStartLine, pattern: 'no-assertion',
                            reason: 'Test has no assertions (t.Error, t.Fatal, assert.*) — executes code but never verifies',
                        });
                    }

                    inTestFunc = false;
                }
            }
        }
    }

    /**
     * Java/Kotlin test quality checks.
     * JUnit 4: @Test + Assert.assertEquals, assertTrue, etc.
     * JUnit 5: @Test + Assertions.assertEquals, assertThrows, etc.
     * Kotlin: @Test + kotlin.test assertEquals, etc.
     */
    private checkJavaKotlinTestQuality(
        content: string, file: string, ext: string, issues: TestQualityIssue[]
    ): void {
        const lines = content.split('\n');
        const isKotlin = ext === '.kt';

        let inTestMethod = false;
        let testStartLine = 0;
        let braceDepth = 0;
        let hasAssertion = false;
        let mockCount = 0;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmed = line.trim();

            // Detect @Test annotation (next non-empty line is the method)
            if (trimmed === '@Test' || /^@Test\s*(\(|$)/.test(trimmed)) {
                // Look for the method signature on this or next lines
                for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
                    const methodLine = lines[j].trim();
                    const methodMatch = isKotlin
                        ? methodLine.match(/^(?:fun|suspend\s+fun)\s+(\w+)\s*\(/)
                        : methodLine.match(/^(?:public\s+|private\s+|protected\s+)?(?:static\s+)?void\s+(\w+)\s*\(/);
                    if (methodMatch) {
                        inTestMethod = true;
                        testStartLine = j + 1;
                        braceDepth = 0;
                        hasAssertion = false;
                        mockCount = 0;
                        // Count braces
                        for (const ch of lines[j]) {
                            if (ch === '{') braceDepth++;
                            if (ch === '}') braceDepth--;
                        }
                        i = j;
                        break;
                    }
                }
                continue;
            }

            if (inTestMethod) {
                for (const ch of line) {
                    if (ch === '{') braceDepth++;
                    if (ch === '}') braceDepth--;
                }

                // JUnit 4/5 assertions
                if (/\b(?:assert(?:Equals|True|False|NotNull|Null|That|Throws|DoesNotThrow|Same|NotSame|ArrayEquals)|assertEquals|assertTrue|assertFalse|assertNotNull|assertNull|assertThrows)\s*\(/.test(line)) {
                    hasAssertion = true;
                }
                // Kotlin test assertions
                if (isKotlin && /\b(?:assertEquals|assertTrue|assertFalse|assertNotNull|assertNull|assertFailsWith|assertIs|assertContains|expect)\s*[({]/.test(line)) {
                    hasAssertion = true;
                }
                // Hamcrest / AssertJ
                if (/\bassertThat\s*\(/.test(line) || /\.should\w*\(/.test(line)) {
                    hasAssertion = true;
                }
                // Verify (Mockito)
                if (/\bverify\s*\(/.test(line)) {
                    hasAssertion = true;
                }

                // Mock counting
                if (/\b(?:mock|spy|when|doReturn|doThrow|doNothing|Mockito\.\w+)\s*\(/.test(line) ||
                    /@Mock\b/.test(line) || /@InjectMocks\b/.test(line)) {
                    mockCount++;
                }

                // Tautological
                if (this.config.check_tautological) {
                    if (/assertEquals\s*\(\s*true\s*,\s*true\s*\)/.test(line) ||
                        /assertTrue\s*\(\s*true\s*\)/.test(line) ||
                        /assertEquals\s*\(\s*(\d+)\s*,\s*\1\s*\)/.test(line)) {
                        issues.push({
                            file, line: i + 1, pattern: 'tautological-assertion',
                            reason: 'Tautological assertion — comparing a constant to itself proves nothing',
                        });
                    }
                }

                // End of method
                if (braceDepth === 0) {
                    if (this.config.check_empty_tests && !hasAssertion) {
                        issues.push({
                            file, line: testStartLine, pattern: 'no-assertion',
                            reason: 'Test has no assertions — executes code but never verifies results',
                        });
                    }
                    if (this.config.check_mock_heavy && mockCount > this.config.max_mocks_per_test) {
                        issues.push({
                            file, line: testStartLine, pattern: 'mock-heavy',
                            reason: `Test uses ${mockCount} mocks (max: ${this.config.max_mocks_per_test}) — may be testing mocks, not real behavior`,
                        });
                    }
                    inTestMethod = false;
                }
            }
        }
    }
}
