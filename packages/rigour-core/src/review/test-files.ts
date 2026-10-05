/** A test file, by the conventions test runners use. */
export function isTestFile(file: string): boolean {
    return /\.(test|spec|e2e)\.[cm]?[jt]sx?$/.test(file) || /(^|\/)(__tests__|tests?|e2e)\//.test(file);
}
