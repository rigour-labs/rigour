/**
 * What the team already knows, handed to every judge so a review starts from it instead of from
 * nothing: the verified review lessons and the repository rules for the files the change touches,
 * the findings the team settled (dismissed as not a bug, or refuted with evidence in an earlier
 * round on a file nothing has changed since), and the docs that name the changed code. Built
 * deterministically, without a model; its hash is part of the verdict's fingerprint, so a new
 * lesson or dismissal is never answered by a verdict cached before it.
 *
 * The reviewer dismissal store lives here too: `rigour dismiss <id>` on a reviewer finding records
 * the finding itself, so the same finding re-worded on the same file is recognised and never
 * blocks again.
 */
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { buildReviewTask } from '../review-task.js';
import type { RouterPolicy } from '../../deep/router.js';
import { MATCH_THRESHOLD, similarity } from './consensus.js';
import type { PanelItem } from './panel.js';
import { defaultExec, GH_TIMEOUT_MS, type Exec } from './exec.js';
import { VerdictStore } from './store.js';
import type { OpenItem } from './verdict.js';

export const REVIEW_DISMISSALS = path.join('.rigour', 'dismissed-review-items.json');
const MAX_DOCS = 10;
const MAX_SETTLED = 40;

export interface ReviewDismissal { id: string; file?: string; line?: number; class: string; issue: string; reason: string; at: string }

export function readReviewDismissals(cwd: string): ReviewDismissal[] {
    try {
        const parsed = JSON.parse(fs.readFileSync(path.join(cwd, REVIEW_DISMISSALS), 'utf8'));
        return Array.isArray(parsed?.entries) ? parsed.entries.filter((e: any) => typeof e?.id === 'string' && typeof e?.issue === 'string') : [];
    } catch {
        return [];
    }
}

/** Records "not a bug" for a reviewer finding; idempotent. A human's own review point is never dismissed this way. */
function dismissReviewItem(cwd: string, item: OpenItem, reason: string, at = new Date().toISOString()): boolean {
    if (item.kind === 'prior') return false;
    const entries = readReviewDismissals(cwd);
    if (entries.some(e => e.id === item.id)) return true;
    entries.push({ id: item.id, ...(item.file ? { file: item.file } : {}), ...(item.line ? { line: item.line } : {}), class: item.class, issue: item.issue, reason, at });
    fs.mkdirSync(path.join(cwd, '.rigour'), { recursive: true });
    fs.writeFileSync(path.join(cwd, REVIEW_DISMISSALS), JSON.stringify({ entries }, null, 2));
    return true;
}

/** The dismissal an item repeats: the same id, or the same finding re-worded on the same file. */
export function dismissedAs(item: OpenItem, dismissals: ReviewDismissal[]): ReviewDismissal | undefined {
    if (item.kind === 'prior') return undefined;
    return dismissals.find(d => d.id === item.id)
        ?? dismissals.find(d => similarity(item, { id: d.id, kind: 'finding', class: d.class, file: d.file, line: d.line, issue: d.issue }) >= MATCH_THRESHOLD);
}

export interface ContextInput {
    cwd: string;
    diff: string;
    changedFiles: string[];
    router: RouterPolicy | undefined;
    /** The previous verdict's panel decisions, and the files changed since it. */
    previousPanel: PanelItem[] | undefined;
    touched: Set<string>;
    trackedDocs: string[];
}

/** The context pack as Markdown, its hash for the fingerprint, and the router's count of risky changed functions (undefined when it could not score). */
export function buildContext(input: ContextInput): { text: string; key: string; risky: number | undefined } {
    const sections: string[] = [];
    let task: ReturnType<typeof buildReviewTask> | undefined;
    try {
        task = buildReviewTask(input.cwd, input.diff, input.router);
    } catch {
        task = undefined;
    }
    if (task?.lessons.length) sections.push(`## Lessons this team verified on earlier reviews, for the files this change touches\n${task.lessons.map(l => `- ${l.file}: ${l.text}${l.prs.length ? ` (PR ${l.prs.join(', ')})` : ''}`).join('\n')}`);
    if (task?.rules.length) sections.push(`## Repository rules that name what this change touches\n${task.rules.map(r => `- ${r.source}: ${r.text}`).join('\n')}`);

    const dismissed = readReviewDismissals(input.cwd).slice(-MAX_SETTLED).map(d => `- dismissed as not a bug: ${where(d)} [${d.class}] ${d.issue} (reason: ${d.reason})`);
    const refuted = (input.previousPanel ?? []).filter(p => p.status === 'dropped' && !!p.item.file && !input.touched.has(p.item.file)).slice(0, MAX_SETTLED)
        .map(p => `- refuted with evidence in the last round: ${where(p.item)} [${p.item.class}] ${p.item.issue} (${(p.cross ?? []).find(c => c.call === 'refute')?.evidence ?? 'evidence in the previous verdict'})`);
    if (dismissed.length || refuted.length) sections.push(`## Settled: do not raise these again unless the code now shows something new\n${[...dismissed, ...refuted].join('\n')}`);

    const docs = relatedDocs(input.cwd, input.changedFiles, input.trackedDocs);
    if (docs.length) sections.push(`## Docs that describe the changed code (read one when its claim matters to a finding)\n${docs.map(d => `- ${d.doc} (names ${d.names.join(', ')})`).join('\n')}`);

    const text = sections.length ? `# What this team already knows\n\n${sections.join('\n\n')}\n` : 'none\n';
    return { text, key: createHash('sha256').update(text).digest('hex').slice(0, 16), risky: task ? task.items.length + task.alreadyReviewed : undefined };
}

function where(x: { file?: string; line?: number }): string {
    return x.file ? `${x.file}${x.line ? `:${x.line}` : ''}` : '(no file)';
}

/** Tracked Markdown docs that name a changed file by path or by a distinctive file stem. */
function relatedDocs(cwd: string, changedFiles: string[], trackedDocs: string[]): Array<{ doc: string; names: string[] }> {
    const names = changedFiles.flatMap(file => {
        const stem = path.posix.basename(file).replace(/\.[^.]+$/, '');
        return stem.length >= 5 && !/^(index|types|utils|helpers|config|main)$/.test(stem) ? [file, stem] : [file];
    });
    const found: Array<{ doc: string; names: string[] }> = [];
    for (const doc of trackedDocs) {
        if (found.length >= MAX_DOCS) break;
        let text: string;
        try {
            text = fs.readFileSync(path.join(cwd, doc), 'utf8');
        } catch {
            continue;
        }
        const hits = [...new Set(names.filter(name => text.includes(name)))];
        if (hits.length) found.push({ doc, names: hits.slice(0, 3) });
    }
    return found;
}

/** `rigour dismiss <id>` on a reviewer finding: the item is found in this branch's latest verdict and recorded with its reason. */
export async function dismissReviewerFinding(cwd: string, id: string, reason: string, exec: Exec = defaultExec): Promise<{ item?: OpenItem; error?: string }> {
    const store = await VerdictStore.open(cwd, exec);
    if (!store) return { error: 'not a git repository' };
    const branch = (await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeoutMs: GH_TIMEOUT_MS })).stdout.trim();
    const state = store.branchState(branch);
    const open = state ? store.readJson<OpenItem[]>(store.openPath(state.verdict)) ?? [] : [];
    const item = open.find(i => i.id === id);
    if (!item) return { error: `no open reviewer finding ${id} on ${branch}: run \`rigour review --reviewer\` and copy the id it shows` };
    if (!dismissReviewItem(cwd, item, reason)) return { error: `${id} is a human review point: answer it in the reply, it cannot be dismissed here` };
    return { item };
}
