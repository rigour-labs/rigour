/**
 * Language-specific test quality checks for Go and Java/Kotlin.
 * Extracted from test-quality.ts to keep it under 500 lines.
 */

export interface TestQualityIssue {
    file: string;
    line: number;
    pattern: string;
    reason: string;
}

export interface TestQualityConfig {
    check_empty_tests?: boolean;
    check_tautological?: boolean;
    check_mock_heavy?: boolean;
    max_mocks_per_test?: number;
}

/**
 * Go test quality checks.
 * Go tests use func TestXxx(t *testing.T) pattern.
 * Assertions via t.Fatal, t.Error, t.Fatalf, t.Errorf, t.Fail, t.FailNow.
 * Also checks for t.Run subtests and table-driven patterns.
 */
export function checkGoTestQuality(content: string, file: string, issues: TestQualityIssue[], config: TestQualityConfig): void {
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
            if (config.check_tautological) {
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

                if (config.check_empty_tests && meaningful.length === 0) {
                    issues.push({
                        file, line: testStartLine, pattern: 'empty-test',
                        reason: 'Empty test function — no test logic',
                    });
                } else if (config.check_empty_tests && !hasAssertion && meaningful.length > 0) {
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
export function checkJavaKotlinTestQuality(
    content: string, file: string, ext: string, issues: TestQualityIssue[], config: TestQualityConfig
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
            if (config.check_tautological) {
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
                if (config.check_empty_tests && !hasAssertion) {
                    issues.push({
                        file, line: testStartLine, pattern: 'no-assertion',
                        reason: 'Test has no assertions — executes code but never verifies results',
                    });
                }
                if (config.check_mock_heavy && mockCount > config.max_mocks_per_test!) {
                    issues.push({
                        file, line: testStartLine, pattern: 'mock-heavy',
                        reason: `Test uses ${mockCount} mocks (max: ${config.max_mocks_per_test}) — may be testing mocks, not real behavior`,
                    });
                }
                inTestMethod = false;
            }
        }
    }
}
