import type { Report } from '../types/index.js';

/**
 * Why deep analysis did not run, or undefined when it ran (fully or
 * partially) or was not requested. Callers use this to fail loudly instead
 * of presenting an empty deep result as a clean pass.
 */
export function deepAnalysisError(report: Pick<Report, 'stats'>): string | undefined {
    const deep = report.stats.deep;
    if (deep?.status !== 'error') return undefined;
    return deep.error || 'unknown error';
}
