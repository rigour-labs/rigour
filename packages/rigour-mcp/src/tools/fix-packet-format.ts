import { mustFix, shownSeverity, type ChangeReview, type Failure } from '@rigour-labs/core';

export const DEFAULT_FIX_PACKET_PAGE_SIZE = 5;
export const MAX_FIX_PACKET_PAGE_SIZE = 10;

const MAX_ITEM_CHARS = 1_600;

/** What the agent is told to do with the packet: the same rule the stop hook and the push gate hold it to. */
export const FIX_PACKET_INSTRUCTION = 'Fix every must-fix item: each one blocks you at the stop hook and the push gate. Notes are optional. '
    + 'Do not edit files outside your change unless a must-fix item names them. Re-run rigour_check after your fixes.';

interface PacketItem {
    failure: Failure;
    /** Blocks the agent: a finding to fix on its change, a branch check, or a check that could not run. */
    blocks: boolean;
}

function clip(value: unknown, max: number): string {
    const text = String(value ?? '');
    return text.length <= max ? text : `${text.slice(0, max - 16)}... [truncated]`;
}

/** Must-fix first, then the notes on the change: the order every page keeps. */
function packetItems(review: ChangeReview): PacketItem[] {
    const notes = [...review.result.advisory, ...review.result.fileFindings];
    return [...review.blocking.map(failure => ({ failure, blocks: true })), ...notes.map(failure => ({ failure, blocks: false }))];
}

function formatItem(item: PacketItem, number: number, of: number): string {
    const f = item.failure;
    const where = f.files?.length ? `${clip(f.files[0], 160)}${f.line ? `:${f.line}` : ''}` : '';
    const lines = [
        `━━━ ${item.blocks ? 'MUST FIX' : 'NOTE'} ${number}/${of}: [${shownSeverity(f).toUpperCase()}] ${clip(f.title, 180)} ━━━`,
        `CHECK: ${clip(f.id, 100)}${f.certainty ? ` | certainty: ${f.certainty}` : ''}${item.blocks && !mustFix(f) ? ' | blocks as a branch or environment check' : ''}`,
        ...(where ? [`WHERE: ${where}`] : []),
        `PROBLEM: ${clip(f.details, 600)}`,
        ...(f.hint ? [`FIX: ${clip(f.hint, 300)}`] : []),
    ];
    return clip(lines.join('\n'), MAX_ITEM_CHARS);
}

/**
 * One page of the agent's work order for its change: what blocks it ("Must fix") before what is optional ("Notes"),
 * each with the check, how sure it is, the exact file and line, and the fix.
 */
export function formatFixPacketPage(review: ChangeReview, offset: number, limit: number): string {
    const items = packetItems(review);
    const mustCount = review.blocking.length;
    const total = items.length;
    const start = Math.min(offset, total);
    const end = Math.min(start + limit, total);
    const lines = [
        `Your change, against ${review.against}: ${mustCount} must fix (blocks you), ${total - mustCount} note${total - mustCount === 1 ? '' : 's'} (optional).`,
        FIX_PACKET_INSTRUCTION,
        `Page: ${start}-${end} of ${total} | next_offset: ${end < total ? end : 'none'}`,
        '',
    ];
    for (let index = start; index < end; index++) {
        const item = items[index];
        // A section heading where a page starts and where must-fix gives way to notes.
        if (index === start || item.blocks !== items[index - 1].blocks) lines.push(item.blocks ? 'MUST FIX (blocks you)' : 'NOTES (optional)', '');
        const number = item.blocks ? index + 1 : index - mustCount + 1;
        lines.push(formatItem(item, number, item.blocks ? mustCount : total - mustCount), '');
    }
    lines.push(end < total
        ? `More remain. Call rigour_get_fix_packet with offset=${end} and limit=${limit}.`
        : 'End of the packet. Re-run rigour_check after your fixes; report done only when nothing must be fixed.');
    return lines.join('\n');
}
