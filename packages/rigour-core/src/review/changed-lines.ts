/**
 * Which findings belong to a change.
 *
 * - findings: on a changed line; these decide PASS/FAIL. A deep finding on an
 *   unchanged line inside a changed function also belongs here, with
 *   `anchorLine` set to the nearest changed line (where a PR comment can go).
 * - fileFindings: about a changed file as a whole (no line); shown as context.
 * - contextFindings: deep findings elsewhere in a changed file; returned so
 *   nothing the model found disappears, never blocking.
 * - unlocated: no file at all; counted, never shown as a changed-line finding.
 * - outside: any other finding on an unchanged line; counted, and kept in
 *   outsideFindings so a check whose findings are all here can say so.
 *
 * The CLI, the MCP tool and the GitHub integration all use this, so the same
 * change gets the same verdict everywhere.
 */
import type { Failure } from '../types/index.js';
import type { RemovedBlock } from '../utils/diff.js';
import { anchorInChangedFunction, type LineSpan } from './changed-function-spans.js';

export interface ChangedLineSplit {
    findings: Failure[];
    fileFindings: Failure[];
    contextFindings: Failure[];
    unlocated: number;
    outside: number;
    outsideFindings: Failure[];
}

export function splitByChangedLines(
    failures: Failure[], changedLines: Record<string, Set<number>>, spans: Record<string, LineSpan[]> = {},
    removed: Record<string, RemovedBlock[]> = {},
): ChangedLineSplit {
    const split: ChangedLineSplit = { findings: [], fileFindings: [], contextFindings: [], unlocated: 0, outside: 0, outsideFindings: [] };
    for (const failure of failures) {
        const files = failure.files ?? [];
        if (files.length === 0) {
            split.unlocated++;
        } else if (failure.line === undefined) {
            if (files.some(file => changedLines[file])) split.fileFindings.push(failure);
            else leftOutside(split, failure);
        } else if (files.some(file => changedLines[file]?.has(failure.line as number) || removedInside(failure, removed[file]))) {
            split.findings.push(failure);
        } else if (failure.provenance === 'deep-analysis') {
            placeDeepFinding(failure, files, changedLines, spans, split);
        } else {
            leftOutside(split, failure);
        }
    }
    return split;
}

function leftOutside(split: ChangedLineSplit, failure: Failure): void {
    split.outside++;
    split.outsideFindings.push(failure);
}

function placeDeepFinding(
    failure: Failure, files: string[], changedLines: Record<string, Set<number>>, spans: Record<string, LineSpan[]>, split: ChangedLineSplit,
): void {
    for (const file of files) {
        const anchorLine = anchorInChangedFunction(failure.line as number, changedLines[file], spans[file]);
        if (anchorLine !== undefined) {
            split.findings.push({ ...failure, anchorLine });
            return;
        }
    }
    if (files.some(file => changedLines[file])) split.contextFindings.push(failure);
    else split.outside++;
}

/**
 * Whether the change deleted lines inside a multi-line finding (its line to endLine), such as an
 * option removed from a call whose first line did not change: that call is part of the change.
 */
function removedInside(failure: Failure, blocks: RemovedBlock[] | undefined): boolean {
    const end = failure.endLine;
    if (!blocks?.length || end === undefined || failure.line === undefined || end <= failure.line) return false;
    return blocks.some(block => block.line > (failure.line as number) && block.line <= end);
}
