/**
 * Test Quality Gate — Assertion Pattern Matchers and Test Anti-Patterns
 *
 * Contains assertion pattern matchers and test anti-pattern regexes.
 */

/**
 * Regex patterns for detecting assertions in JavaScript/TypeScript tests
 */
export const JS_ASSERTION_PATTERNS = [
    /expect\s*\(/,
    /assert\s*[.(]/,
    /\.toEqual|\.toBe|\.toContain|\.toMatch|\.toThrow|\.toHaveBeenCalled|\.toHaveLength|\.toBeTruthy|\.toBeFalsy|\.toBeDefined|\.toBeNull|\.toBeUndefined|\.toBeGreaterThan|\.toBeLessThan|\.toHaveProperty|\.toStrictEqual|\.rejects|\.resolves/,
];

/**
 * Regex patterns for detecting mocks in JavaScript/TypeScript tests
 */
export const JS_MOCK_PATTERNS = [
    /jest\.fn\(/,
    /vi\.fn\(/,
    /jest\.mock\(/,
    /vi\.mock\(/,
    /jest\.spyOn\(/,
    /vi\.spyOn\(/,
    /sinon\.(stub|mock|spy)\(/,
];

/**
 * Regex patterns for detecting assertions in Python tests
 */
export const PYTHON_ASSERTION_PATTERNS = [
    /\bassert\s+/,
    /self\.assert\w+\s*\(/,
    /pytest\.raises\s*\(/,
    /\.assert_called|\.assert_any_call/,
];

/**
 * Regex patterns for detecting mocks in Python tests
 */
export const PYTHON_MOCK_PATTERNS = [
    /mock\./,
    /Mock\(/,
    /patch\(/,
    /MagicMock\(/,
];

/**
 * Test block pattern for JavaScript/TypeScript
 */
export const JS_TEST_START_PATTERN = /^(?:it|test)\s*\(\s*['"`].*['"`]\s*,\s*(async\s+)?(?:\(\s*\)|function\s*\(\s*\)|\(\s*\{[^}]*\}\s*\))\s*(?:=>)?\s*\{/;

/**
 * Python test function pattern
 */
export const PYTHON_TEST_FUNC_PATTERN = /^(\s*)(?:def|async\s+def)\s+(test_\w+)\s*\(/;

/**
 * Tautological assertion patterns for JavaScript
 */
export const JS_TAUTOLOGICAL_PATTERNS = [
    /expect\s*\(\s*true\s*\)\s*\.toBe\s*\(\s*true\s*\)/,
    /expect\s*\(\s*false\s*\)\s*\.toBe\s*\(\s*false\s*\)/,
    /expect\s*\(\s*1\s*\)\s*\.toBe\s*\(\s*1\s*\)/,
];

/**
 * Variable tautology pattern for JavaScript
 */
export const JS_VAR_TAUTOLOGY_PATTERN = /expect\s*\(\s*(\w+)\s*\)\s*\.(?:toBe|toEqual|toStrictEqual)\s*\(\s*(\w+)\s*\)/;

/**
 * Snapshot test patterns
 */
export const SNAPSHOT_PATTERNS = [
    /\.toMatchSnapshot\s*\(/,
    /\.toMatchInlineSnapshot\s*\(/,
];

/**
 * Python tautological patterns
 */
export const PYTHON_TAUTOLOGICAL_PATTERNS = [
    /\bassert\s+True\s*$/,
    /\bassert\s+1\s*==\s*1/,
    /self\.assertTrue\s*\(\s*True\s*\)/,
];

/**
 * Python fixture decorator pattern
 */
export const PYTHON_FIXTURE_PATTERN = /^@pytest\.fixture/;

/**
 * Python conftest file name
 */
export const PYTHON_CONFTEST_NAME = 'conftest.py';
