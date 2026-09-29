import { deepAnalysisError, type Report } from '@rigour-labs/core';

export const EXIT_PASS = 0;
export const EXIT_FAIL = 1;
export const EXIT_CONFIG_ERROR = 2;
export const EXIT_INTERNAL_ERROR = 3;

/**
 * Exit code for a finished run. When deep analysis was requested but could
 * not run, the check did not do what was asked: exit 3 so CI cannot mistake
 * it for a clean or ordinary failing run.
 */
export function exitCodeFor(report: Pick<Report, 'status' | 'stats'>): number {
    if (deepAnalysisError(report)) return EXIT_INTERNAL_ERROR;
    return report.status === 'PASS' ? EXIT_PASS : EXIT_FAIL;
}
