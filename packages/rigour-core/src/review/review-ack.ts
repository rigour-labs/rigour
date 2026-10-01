/**
 * Acknowledge a review-task item: "I checked this function, here is what I
 * found". The hash is taken from the file as it is now, so an acknowledgement
 * covers exactly the code that was reviewed; editing the function afterwards
 * puts it back in the task.
 */
import { findFunction } from '../deep/risk.js';
import { recordReview, type LedgerEntry, type ReviewVerdict } from './ledger.js';

const MIN_NOTE_CHARS = 10;
const VERDICTS: ReadonlyArray<ReviewVerdict> = ['fixed', 'no_issue'];

export interface ReviewAck {
    file: string;
    function: string;
    verdict: string;
    note: string;
    reviewer?: string;
}

export type AckResult = { ok: true; entry: LedgerEntry } | { ok: false; error: string };

export function acknowledgeReview(cwd: string, ack: ReviewAck): AckResult {
    if (!VERDICTS.includes(ack.verdict as ReviewVerdict)) return { ok: false, error: `verdict must be one of: ${VERDICTS.join(', ')}` };
    const note = (ack.note ?? '').trim();
    if (note.length < MIN_NOTE_CHARS) return { ok: false, error: 'note must say what was checked (at least 10 characters)' };
    const file = ack.file.replace(/\\/g, '/').replace(/^\.\//, '');
    const current = findFunction(cwd, file, ack.function);
    if (!current) return { ok: false, error: `no function \`${ack.function}\` in ${file}` };
    const entry = recordReview(cwd, {
        file, function: ack.function, hash: current.hash, reviewer: ack.reviewer || 'agent', verdict: ack.verdict as ReviewVerdict, note,
    });
    return { ok: true, entry };
}
