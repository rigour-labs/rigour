/**
 * A test file, by the conventions test runners use: by name (`x.test.ts`, `x.spec.ts`, `x.e2e.ts`,
 * tsd's `x.test-d.ts`) or by folder (`test/`, `tests/`, `__tests__/`, `__mocks__/`, `e2e/`, tsd's
 * `test-d/`). The one definition every review check uses, so they never disagree about a file.
 */
export function isTestFile(file: string): boolean {
    return /\.(test|spec|e2e|test-d)\.[cm]?[jt]sx?$/.test(file) || /(^|\/)(__tests__|__mocks__|tests?|test-d|e2e)\//.test(file);
}
