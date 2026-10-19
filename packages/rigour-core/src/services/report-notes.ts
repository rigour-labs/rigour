/**
 * The notes in a run's report: findings of a check whose summary says NOTE (a gate that does not block until the
 * team opts in). Listed with the run, never deciding it; every reader of a report shows them the same way.
 */
import type { Failure, Report } from '../types/index.js';

export function reportNotes(report: Pick<Report, 'summary' | 'failures'>): Failure[] {
    return report.failures.filter(failure => report.summary?.[failure.id] === 'NOTE');
}

/** A note as one line: where it is, then what it says. */
export function noteLine(note: Failure): string {
    const where = note.files?.[0] ? `${note.files[0]}${note.line ? `:${note.line}` : ''}: ` : '';
    return `${where}${note.details}`;
}
