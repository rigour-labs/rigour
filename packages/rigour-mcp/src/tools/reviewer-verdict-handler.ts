/**
 * rigour_reviewer_verdict: what the model reviewer last decided for this branch, for the agent
 * that does the fixing. Confirmed items are the work, each with the id a person can dismiss it by;
 * disputed items have no majority and are not work. Read only: it never runs a model (that spends
 * the person's money) and never dismisses (a person decides what is not a bug).
 */
import { execFileSync } from 'child_process';
import { reviewStatus, type OpenItem } from '@rigour-labs/core';
import type { ToolResult } from '../utils/context-telemetry.js';

const git = (cwd: string, args: string[]) => {
    try {
        return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
        return '';
    }
};

const brief = (item: OpenItem) => ({ id: item.id, class: item.class, file: item.file ?? null, line: item.line ?? null, issue: item.issue, consequence: item.consequence ?? null, evidence: item.evidence ?? null, judges: item.reviewer ?? null });

export async function handleReviewerVerdict(cwd: string): Promise<ToolResult> {
    const branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const head = git(cwd, ['rev-parse', 'HEAD']);
    const status = branch ? await reviewStatus(cwd, branch) : undefined;
    if (!status) return { content: [{ type: 'text', text: JSON.stringify({ error: 'not a git repository' }) }], isError: true };
    const last = status.last;
    const answer = {
        branch,
        running: status.running ? { head: status.running.head } : null,
        verdict: last ? {
            head: last.head,
            current: last.head === head,
            scope: last.mode,
            ran: last.ran ?? null,
            fix: last.open.map(brief),
            disputed_not_work: last.disputed.map(brief),
        } : null,
        next: !last
            ? 'No reviewer verdict on this branch yet. A person runs `rigour review --reviewer`, or pushes with the reviewer on.'
            : last.open.length
                ? `Fix each item in "fix", then push; the next review checks each by id.${last.head === head ? '' : ' This verdict is for an earlier commit: some items may already be fixed.'} If one is not a bug, say why to the person: only they can dismiss it.`
                : 'Nothing to fix from the reviewer.',
    };
    return { content: [{ type: 'text', text: JSON.stringify(answer, null, 2) }] };
}
