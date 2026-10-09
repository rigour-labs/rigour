/**
 * The check ids opt-in telemetry may send: Rigour's own, and nothing else. A team's own check (a `commands:` entry, a
 * plugin, anything named in config) can carry a product or customer name, so it is sent only as `custom`. The list is
 * the gate registry's ids, the review's own checks and the hook's: check-ids.test.ts builds the registry and fails
 * when a gate is missing here.
 */
const BUILT_IN = new Set([
    // Gates (gates/runner.ts registers them)
    'agent-team', 'ast-analysis', 'checkpoint', 'content-check', 'context-drift', 'context-window-artifacts', 'coverage-guard', 'deep-analysis',
    'dependency-guardian', 'deprecated-apis', 'deprecated-dependencies', 'duplication-drift', 'environment-alignment', 'file-guard', 'file-size',
    'frontend-secret-exposure', 'hallucinated-imports', 'inconsistent-error-handling', 'logic-drift', 'phantom-apis', 'promise-safety',
    'retry_loop_breaker', 'security-patterns', 'semantic-bugs', 'side-effect-analysis', 'structure-check', 'style-drift', 'test-quality', 'unindexed-reads',
    // The review's own checks (review/review.ts) and their typed checks
    'unused-export', 'orphan-file', 'offset-paging', 'unbounded-window', 'duplicate-function', 'partial-fix', 'partial-wiring', 'quadratic-copy',
    'migration-order', 'diff-tests', 'compiled-lesson', 'goal-scope', 'goal-done-when', 'duplicate-null-filter', 'nullable-filtered-column',
    'optional-always-supplied', 'write-only-property', 'typed-checks-unavailable',
    // The per-edit hook's (hooks/checker.ts)
    'agent-scope', 'governance', 'governance-dlp', 'governance-skills',
]);

/** A check id as telemetry may send it: one of Rigour's own, else `custom`. */
export function telemetryCheckId(id: string): string {
    return BUILT_IN.has(id) ? id : 'custom';
}

