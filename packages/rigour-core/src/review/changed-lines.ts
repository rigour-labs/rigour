/**
 * Which findings belong to a change.
 *
 * - findings: on a changed line; these decide PASS/FAIL.
 * - fileFindings: about a changed file as a whole (no line); shown as context.
 * - unlocated: no file at all; counted, never shown as a changed-line finding.
 * - outside: on an unchanged line; counted.
 *
 * The CLI, the MCP tool and the GitHub integration all use this, so the same
 * change gets the same verdict everywhere.
 */
import type { Failure } from '../types/index.js';

export interface ChangedLineSplit {
    findings: Failure[];
    fileFindings: Failure[];
    unlocated: number;
    outside: number;
}

export function splitByChangedLines(failures: Failure[], changedLines: Record<string, Set<number>>): ChangedLineSplit {
    const split: ChangedLineSplit = { findings: [], fileFindings: [], unlocated: 0, outside: 0 };
    for (const failure of failures) {
        const files = failure.files ?? [];
        if (files.length === 0) {
            split.unlocated++;
        } else if (failure.line === undefined) {
            if (files.some(file => changedLines[file])) split.fileFindings.push(failure);
            else split.outside++;
        } else if (files.some(file => changedLines[file]?.has(failure.line as number))) {
            split.findings.push(failure);
        } else {
            split.outside++;
        }
    }
    return split;
}
