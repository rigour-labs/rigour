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
import { describeLesson, lessonsForDiff, lessonView, rejectedForDiff, type LessonMode } from '../../review-learning/team-lessons.js';
import { rulesForDiff } from '../../review-learning/repo-rules.js';
import { reviewedKeys } from '../ledger.js';
import type { RouterPolicy } from '../../deep/router.js';
import { textSimilarity } from './consensus.js';
import type { PanelItem } from './panel.js';
import { defaultExec, GH_TIMEOUT_MS, type Exec } from './exec.js';
import { VerdictStore } from './store.js';
import type { OpenItem, ServedRule } from './verdict.js';
import { MAX_SETTLED, settledChecks, settledLine, settledSection } from '../settled-checks.js';
import { withoutCompiled } from '../../review-learning/compiled-lessons.js';

export const REVIEW_DISMISSALS = path.join('.rigour', 'dismissed-review-items.json');
const MAX_DOCS = 10;
/** Team standards a judge is shown with the lessons about the changed files. */
const JUDGE_STANDARDS = 15;
/** File lessons a judge is shown: on a pull request touching a hundred files, enough for every file, at most this many per file. */
const JUDGE_FILE_LESSONS = 30;
const JUDGE_LESSONS_PER_FILE = 3;
/** Rules from the repository's own rules files a judge is asked to answer, most relevant first. */
const JUDGE_RULES = 15;

export interface ReviewDismissal { id: string; file?: string; line?: number; class: string; issue: string; reason: string; at: string; by?: string }

export function readReviewDismissals(cwd: string): ReviewDismissal[] {
    try {
        const parsed = JSON.parse(fs.readFileSync(path.join(cwd, REVIEW_DISMISSALS), 'utf8'));
        return Array.isArray(parsed?.entries) ? parsed.entries.filter((e: any) => typeof e?.id === 'string' && typeof e?.issue === 'string') : [];
    } catch {
        return [];
    }
}

/** Records "not a bug" for a reviewer finding; idempotent. A human's own review point is never dismissed this way. */
function dismissReviewItem(cwd: string, item: OpenItem, reason: string, by: string, at = new Date().toISOString()): boolean {
    if (item.kind === 'prior') return false;
    const entries = readReviewDismissals(cwd);
    if (entries.some(e => e.id === item.id)) return true;
    entries.push({ id: item.id, ...(item.file ? { file: item.file } : {}), ...(item.line ? { line: item.line } : {}), class: item.class, issue: item.issue, reason, at, ...(by ? { by } : {}) });
    fs.mkdirSync(path.join(cwd, '.rigour'), { recursive: true });
    fs.writeFileSync(path.join(cwd, REVIEW_DISMISSALS), JSON.stringify({ entries }, null, 2));
    return true;
}

/** Close enough in place and wording that a dismissal of one is a dismissal of the other; a different bug nearby never is. */
const DISMISSAL_LINES = 3;
const DISMISSAL_WORDS = 0.6;

/**
 * The dismissal an item repeats: the same id, or the same finding re-worded: the same file and
 * class, within a few lines, and mostly the same words. A different bug on the same line, or a
 * finding that only shares the file and class, is not dismissed.
 */
export function dismissedAs(item: OpenItem, dismissals: ReviewDismissal[]): ReviewDismissal | undefined {
    if (item.kind === 'prior') return undefined;
    return dismissals.find(d => d.id === item.id) ?? dismissals.find(d =>
        d.file === item.file && d.class === item.class
        && (d.line === undefined || item.line === undefined || Math.abs(d.line - item.line) <= DISMISSAL_LINES)
        && textSimilarity({ ...item, consequence: undefined }, { id: d.id, kind: 'finding', class: d.class, issue: d.issue }) >= DISMISSAL_WORDS);
}

export interface ContextInput {
    cwd: string;
    /** Where .rigour lives: the main checkout when cwd is the background reviewer's worktree. */
    stateRoot: string;
    /** The team's dismissals, when it allows them (empty otherwise). */
    dismissals: ReviewDismissal[];
    diff: string;
    router: RouterPolicy | undefined;
    /** Which of the team's review lessons the judges see (gates.deep.review_lessons): verified by default, all, or off. */
    lessons?: LessonMode;
    /** The pull request under review: lessons learned only from it are its own reviews, which the judge already reads. */
    pr?: number;
    /** The previous verdict's panel decisions, and the files changed since it. */
    previousPanel: PanelItem[] | undefined;
    touched: Set<string>;
    /** Docs that name the changed code (relatedDocs). */
    docs: Array<{ doc: string; names: string[] }>;
    /** Findings Rigour's checks already report on this change, one line each. */
    checks: string[];
}

/** A review's result as the reviewer's inputs: its hints, and what its checks found, as settled. */
export function reviewerInputs(review: { hints: string[]; findings: Array<{ files?: string[]; line?: number; title: string }> }): { hints: string; checks: string[] } {
    return { hints: review.hints.join('\n'), checks: settledChecks(review.findings).map(settledLine) };
}

/** A lesson as the judge was shown it: its id, and the line it was listed as (the judge answers by that line). */
export interface ServedLesson { id: string; listed: string }

/** The ids of the served lessons the judge said this change repeats; an answer that names no served lesson says nothing. */
export function lessonsApplied(answers: Array<{ lesson: string; applies: boolean }>, served: ServedLesson[]): string[] {
    const norm = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim();
    const ids = answers.filter(a => a.applies === true && typeof a.lesson === 'string').map(a => served.find(s => norm(s.listed) === norm(a.lesson) || (norm(a.lesson).length >= 20 && norm(s.listed).startsWith(norm(a.lesson))))?.id);
    return [...new Set(ids.filter((id): id is string => !!id))];
}

/** The context pack as Markdown, its hash for the fingerprint, and the router's count of risky changed functions (undefined when it could not score). */
export function buildContext(input: ContextInput): { text: string; key: string; risky: number | undefined; rules: ServedRule[]; lessons: number; servedLessons: ServedLesson[] } {
    const sections: string[] = [];
    let task: ReturnType<typeof buildReviewTask> | undefined;
    try {
        task = buildReviewTask(input.cwd, input.diff, input.router, input.lessons, undefined, reviewedKeys(input.stateRoot));
    } catch {
        task = undefined;
    }
    // A judge reads the whole pull request: more of what the team taught fits than an agent's one question at the stop.
    const servedLessons: ServedLesson[] = input.lessons === 'off' ? [] : withoutCompiled(input.cwd, lessonsForDiff(input.cwd, input.diff, input.lessons, JUDGE_STANDARDS, JUDGE_FILE_LESSONS, JUDGE_LESSONS_PER_FILE, input.pr)).map(l => ({ id: l.id, listed: describeLesson(lessonView(l)) }));
    if (servedLessons.length) sections.push(`## Lessons this team taught on earlier reviews, for what this change touches (context: a lesson never blocks on its own; a finding still needs its quote)\n${servedLessons.map(l => `- ${l.listed}`).join('\n')}`);
    // The repository's own rules, always: the reviewer is the boundary, and what the team wrote is the standard it checks.
    const rules = rulesForDiff(input.cwd, input.diff, true, JUDGE_RULES).map((r): ServedRule => ({ id: r.id, source: r.source, text: r.text, requirement: r.requirement }));
    if (rules.length) sections.push(`## Rules this repository wrote for itself that apply to this change (answer every one in rules, by id)\n${rules.map(r => `- [${r.id}] (${r.source}, ${r.requirement ? 'requirement' : 'guidance'}) ${r.text}`).join('\n')}`);

    if (input.checks.length) sections.push(settledSection(input.checks));
    const rejected = input.lessons === 'off' ? [] : rejectedForDiff(input.cwd, input.diff).map(l => {
        const no = l.evidence.filter(e => e.kind === 'rejected').at(-1);
        return `- this team decided against: ${l.text}${no?.author ? ` (rejected by ${no.author}${no.detail ? `: ${no.detail}` : ''})` : ''}`;
    });
    const dismissed = input.dismissals.slice(-MAX_SETTLED).map(d => `- dismissed as not a bug${d.by ? ` by ${d.by}` : ''}: ${where(d)} [${d.class}] ${d.issue} (reason: ${d.reason})`);
    const refuted = (input.previousPanel ?? []).filter(p => p.status === 'dropped' && !!p.item.file && !input.touched.has(p.item.file)).slice(0, MAX_SETTLED)
        .map(p => `- refuted with evidence in the last round: ${where(p.item)} [${p.item.class}] ${p.item.issue} (${(p.cross ?? []).find(c => c.call === 'refute')?.evidence ?? 'evidence in the previous verdict'})`);
    if (dismissed.length || refuted.length || rejected.length) sections.push(`## Settled: do not raise these again unless the code now shows something new\n${[...rejected, ...dismissed, ...refuted].join('\n')}`);

    const docs = input.docs;
    if (docs.length) sections.push(`## Docs that describe the changed code (read one when its claim matters to a finding)\n${docs.map(d => `- ${d.doc} (names ${d.names.join(', ')})`).join('\n')}`);

    const text = sections.length ? `# What this team already knows\n\n${sections.join('\n\n')}\n` : 'none\n';
    return { text, key: createHash('sha256').update(text).digest('hex').slice(0, 16), risky: task ? task.items.length + task.alreadyReviewed : undefined, rules, lessons: servedLessons.length, servedLessons };
}

function where(x: { file?: string; line?: number }): string {
    return x.file ? `${x.file}${x.line ? `:${x.line}` : ''}` : '(no file)';
}

/**
 * Tracked Markdown docs that name a changed file by path or by a distinctive file stem: one
 * `git grep` over the docs, never a read of every one, stopping at the first few.
 */
export async function relatedDocs(cwd: string, changedFiles: string[], exec: Exec = defaultExec): Promise<Array<{ doc: string; names: string[] }>> {
    const names = [...new Set(changedFiles.flatMap(file => {
        const stem = path.posix.basename(file).replace(/\.[^.]+$/, '');
        return stem.length >= 5 && !/^(index|types|utils|helpers|config|main)$/.test(stem) ? [file, stem] : [file];
    }))];
    if (!names.length) return [];
    const grep = await exec('git', ['grep', '-I', '-F', '-o', ...names.flatMap(name => ['-e', name]), '--', '*.md'], { cwd, timeoutMs: GH_TIMEOUT_MS });
    const found = new Map<string, Set<string>>();
    for (const line of grep.stdout.split('\n')) {
        const at = line.indexOf(':');
        if (at <= 0) continue;
        const doc = line.slice(0, at);
        if (!found.has(doc) && found.size >= MAX_DOCS) continue;
        found.set(doc, (found.get(doc) ?? new Set()).add(line.slice(at + 1)));
    }
    return [...found].map(([doc, hits]) => ({ doc, names: [...hits].slice(0, 3) }));
}

/**
 * `rigour dismiss <id>` on a reviewer finding: only where the team allows it (`review.reviewer.dismissals`), with a
 * reason, recorded with who dismissed it. The item is found in this branch's latest verdict.
 */
export async function dismissReviewerFinding(cwd: string, id: string, reason: string, allowed: boolean, exec: Exec = defaultExec): Promise<{ item?: OpenItem; error?: string }> {
    if (!allowed) return { error: 'this team does not dismiss reviewer findings (review.reviewer.dismissals is off): fix the code, or improve the reviewer (its prompt, rules or the reviewers it runs) so the finding is not raised' };
    if (reason.trim().length < 5) return { error: 'say why it is not a bug, in a few words' };
    const store = await VerdictStore.open(cwd, exec);
    if (!store) return { error: 'not a git repository' };
    const branch = (await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeoutMs: GH_TIMEOUT_MS })).stdout.trim();
    const state = store.branchState(branch);
    const open = state ? store.readJson<OpenItem[]>(store.openPath(state.verdict)) ?? [] : [];
    const item = open.find(i => i.id === id);
    if (!item) return { error: `no open reviewer finding ${id} on ${branch}: run \`rigour review --reviewer\` and copy the id it shows` };
    const who = (await exec('git', ['config', 'user.email'], { cwd, timeoutMs: GH_TIMEOUT_MS })).stdout.trim() || (await exec('git', ['config', 'user.name'], { cwd, timeoutMs: GH_TIMEOUT_MS })).stdout.trim();
    if (!dismissReviewItem(cwd, item, reason, who)) return { error: `${id} is a human review point: answer it in the reply, it cannot be dismissed here` };
    return { item };
}
