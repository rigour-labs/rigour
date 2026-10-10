/**
 * The briefing: before an agent writes, what a senior on this team would tell it about the task. The repository's own
 * rules and the team's verified lessons for the files the task will likely touch, and the points the team settled
 * against (so the agent does not re-raise or re-do them), at most `limit` items, each cited to where it came from.
 *
 * Nothing here is new knowledge: the same rules and lessons the reviewer checks a change against, selected by the same
 * matchers, before the code exists instead of after. It is deterministic (no model call), local, and it never blocks.
 */
import { spawnSync } from 'child_process';
import path from 'path';
import { rulesForDiff, type RepoRule } from '../review-learning/repo-rules.js';
import type { ReviewLesson } from '../review-learning/lessons.js';
import { describeLesson, lessonsForDiff, lessonView, rejectedForDiff, type LessonMode } from '../review-learning/team-lessons.js';
import { appendTaskEvent, taskOf } from '../task/thread.js';

/** The most items a briefing gives: past about ten, a briefing is a wall nobody reads. */
export const BRIEFING_MAX_ITEMS = 10;
/** The most items a briefing for one file gives, the first time an agent edits it: a word in passing, not a wall. */
export const FILE_BRIEFING_MAX_ITEMS = 3;
/** A rule longer than this is served by its first sentence and where the whole rule is: one item never floods the briefing. */
const ITEM_MAX_CHARS = 400;
/** All items of a briefing together, at most: once one would pass it, the rest wait for the reviewer. */
const BRIEFING_MAX_CHARS = 3000;
/** The most files a briefing reads the task's likely reach from. */
const LIKELY_FILES = 20;

export interface BriefingItem {
    kind: 'rule' | 'lesson' | 'settled';
    /** What to do, in the team's words (a rule's text, a lesson's rule). */
    text: string;
    /** Where it came from: the rules file, or the pull requests the lesson was learned and proven on. */
    cite: string;
    /** A rule the team worded as a requirement: a break blocks at review. */
    requirement?: boolean;
    id: string;
}

export interface Briefing {
    task?: string;
    goal: string;
    files: string[];
    items: BriefingItem[];
}

export interface BriefingInput {
    /** What the task is for: the agent's first prompt, a ticket's summary, the pull request's title. The branch name when absent. */
    goal?: string;
    /** The files the task will touch, when known; otherwise the branch's own changes and the files the goal names. */
    files?: string[];
    lessons?: LessonMode;
    limit?: number;
}

/**
 * The briefing for a task in this checkout: requirement rules first (a break of one blocks later), then the team's
 * verified lessons, then the points the team settled against, then guidance rules; `limit` items at most.
 */
export function buildBriefing(cwd: string, input: BriefingInput = {}): Briefing {
    const task = taskOf(cwd);
    const goal = (input.goal?.trim() || (task ? task.branch.replace(/[/_-]+/g, ' ') : '')).slice(0, 2000);
    const files = (input.files?.length ? input.files : likelyFiles(cwd, goal)).slice(0, LIKELY_FILES);
    const limit = Math.max(0, Math.min(input.limit ?? BRIEFING_MAX_ITEMS, BRIEFING_MAX_ITEMS));
    // The rule and lesson matchers read a change: the task's files and the goal's words stand in for the code to come.
    const shape = shapeOf(files, goal);
    // Only rules that name a path or identifier of the task: the reviewer can judge a rule against code; a briefing cannot.
    const rules = rulesForDiff(cwd, shape, true, limit, true);
    const lessons = lessonsForDiff(cwd, shape, input.lessons ?? 'verified', 5, limit, 3).filter(l => l.state === 'verified' || input.lessons === 'all');
    const settled = rejectedForDiff(cwd, shape);
    const cited = (prs: number[]) => (prs.length ? `learned in PR ${prs.map(p => `#${p}`).join(', ')}` : 'the team\'s decision');
    const items: BriefingItem[] = [
        ...rules.filter(r => r.requirement).map(ruleItem),
        ...lessons.map(l => {
            const view = lessonView(l);
            return { kind: 'lesson' as const, text: describeLesson({ ...view, prs: [] }), cite: cited(view.prs), id: `lesson:${l.id}` };
        }),
        ...settled.map(l => ({ kind: 'settled' as const, text: `settled against, do not do or raise it: ${lessonView(l).text}`, cite: cited(lessonView(l).prs), id: `settled:${l.id}` })),
        ...rules.filter(r => !r.requirement).map(ruleItem),
    ];
    return { ...(task ? { task: task.key } : {}), goal, files, items: withinBudget(items.slice(0, limit)) };
}

/**
 * A repository rule as a briefing item, whole when it fits; an over-long one by its first sentence and where the whole
 * rule is (`full rule: AGENTS.md:12`), never cut mid-sentence.
 */
function ruleItem(r: RepoRule): BriefingItem {
    const where = `${r.source}${r.line ? `:${r.line}` : ''}`;
    const text = r.text.length <= ITEM_MAX_CHARS ? r.text : `${r.text.split(/(?<=[.!?])\s/)[0]} (full rule: ${where})`;
    return { kind: 'rule', text, cite: ruleCite(r.source, r.scope), ...(r.requirement ? { requirement: true } : {}), id: `rule:${r.id}` };
}

/** Items in order while their text and citations fit BRIEFING_MAX_CHARS together; the first always. */
function withinBudget(items: BriefingItem[]): BriefingItem[] {
    let used = 0;
    return items.filter((item, i) => {
        used += item.text.length + item.cite.length;
        return i === 0 || used <= BRIEFING_MAX_CHARS;
    });
}

/** The briefing as an agent reads it: short, numbered, each item with where it came from. Empty when there is nothing to say. */
export function briefingText(briefing: Briefing): string {
    if (briefing.items.length === 0) return '';
    const lines = briefing.items.map((item, i) => `${i + 1}. ${item.requirement ? '[must] ' : item.kind === 'settled' ? '[settled] ' : ''}${item.text} (${item.cite})`);
    return [`Rigour briefing${briefing.task ? ` for ${briefing.task}` : ''}: how this team builds the code this task will likely touch. Follow these; a [must] broken in your change blocks at review.`, ...lines].join('\n');
}

/**
 * The briefing for one file, the first time an agent edits it: the requirement rules that name it (or its folder), the
 * lessons the team learned on it, then those a person widened to its folder or the whole repository, and the points
 * the team settled against on it; at most three. At session start the
 * task's files are often unknown; the first edit of a file is when they are, and when a briefing can be specific.
 */
export function buildFileBriefing(cwd: string, file: string, input: { lessons?: LessonMode; limit?: number } = {}): Briefing {
    const task = taskOf(cwd);
    const limit = Math.max(0, Math.min(input.limit ?? FILE_BRIEFING_MAX_ITEMS, FILE_BRIEFING_MAX_ITEMS));
    const shape = shapeOf([file], '');
    const mode = input.lessons ?? 'verified';
    const rules = rulesForDiff(cwd, shape, true, BRIEFING_MAX_ITEMS, true).filter(r => r.requirement);
    const reaches = (l: ReviewLesson) => l.file === file || l.scope === 'repo' || (l.scope === 'folder' && file.startsWith(`${path.posix.dirname(l.file)}/`));
    const lessons = lessonsForDiff(cwd, shape, mode, 0, BRIEFING_MAX_ITEMS, BRIEFING_MAX_ITEMS).filter(l => reaches(l) && (l.state === 'verified' || mode === 'all'));
    const settled = rejectedForDiff(cwd, shape).filter(l => l.file === file);
    const cited = (prs: number[]) => (prs.length ? `learned in PR ${prs.map(p => `#${p}`).join(', ')}` : 'the team\'s decision');
    const items: BriefingItem[] = [
        ...rules.map(ruleItem),
        // This file's own lessons read as they are; a widened one says where it reaches (a folder, the team).
        ...lessons.map(l => ({ kind: 'lesson' as const, text: l.file === file && !l.scope ? lessonView(l).text : describeLesson({ ...lessonView(l), prs: [] }), cite: cited(lessonView(l).prs), id: `lesson:${l.id}` })),
        ...settled.map(l => ({ kind: 'settled' as const, text: `settled against, do not do or raise it: ${lessonView(l).text}`, cite: cited(lessonView(l).prs), id: `settled:${l.id}` })),
    ];
    return { ...(task ? { task: task.key } : {}), goal: '', files: [file], items: withinBudget(items.slice(0, limit)) };
}

/** A file's briefing as an agent reads it, just before it edits that file. Empty when there is nothing to say. */
export function fileBriefingText(briefing: Briefing): string {
    if (briefing.items.length === 0) return '';
    const lines = briefing.items.map((item, i) => `${i + 1}. ${item.requirement ? '[must] ' : item.kind === 'settled' ? '[settled] ' : ''}${item.text} (${item.cite})`);
    return [`Rigour, before you edit ${briefing.files[0]}: what this team asks of this file.`, ...lines].join('\n');
}

/** Builds a file's briefing and records it on the task's thread, with the file. */
export function briefFile(cwd: string, file: string, input: { lessons?: LessonMode; limit?: number; session?: string; agent?: string } = {}): Briefing {
    const briefing = buildFileBriefing(cwd, file, input);
    appendTaskEvent(cwd, { kind: 'brief', file, ...(input.session ? { session: input.session } : {}), ...(input.agent ? { agent: input.agent } : {}), items: briefing.items.length, ids: briefing.items.map(i => i.id), files: [file] });
    return briefing;
}

/** Builds the briefing and records it on the task's thread (what was briefed, by id, so a later review can be read against it). */
export function briefTask(cwd: string, input: BriefingInput & { session?: string; agent?: string }): Briefing {
    const briefing = buildBriefing(cwd, input);
    appendTaskEvent(cwd, { kind: 'brief', ...(input.session ? { session: input.session } : {}), ...(input.agent ? { agent: input.agent } : {}), items: briefing.items.length, ids: briefing.items.map(i => i.id), files: briefing.files });
    return briefing;
}

function ruleCite(source: string, scope?: string): string {
    return scope ? `${source}, for ${scope}` : source;
}

/** A stand-in change for the matchers: each file as touched, the goal's words as the added line. */
function shapeOf(files: string[], goal: string): string {
    const words = goal.replace(/\s+/g, ' ');
    const touched = files.length ? files : ['.'];
    return touched.map(f => `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n@@ -0,0 +1,1 @@\n+${words}\n`).join('');
}

/** The files a task will likely touch: what the branch already changed, then tracked files whose path names a word of the goal. */
function likelyFiles(cwd: string, goal: string): string[] {
    const files: string[] = [];
    const main = ['origin/main', 'main', 'origin/master', 'master'].find(ref => git(cwd, ['rev-parse', '--verify', '-q', ref]) !== undefined);
    const base = main ? git(cwd, ['merge-base', 'HEAD', main]) : undefined;
    if (base) files.push(...(git(cwd, ['diff', '--name-only', `${base}...HEAD`]) ?? '').split('\n').filter(Boolean));
    const words = [...new Set(goal.toLowerCase().match(/[a-z][a-z0-9]{3,}/g) ?? [])].filter(w => !STOP.has(w));
    if (words.length) {
        const tracked = (git(cwd, ['ls-files']) ?? '').split('\n').filter(Boolean);
        for (const file of tracked) {
            if (files.length >= LIKELY_FILES) break;
            const name = file.toLowerCase();
            if (!files.includes(file) && words.some(w => name.includes(w))) files.push(file);
        }
    }
    return files;
}

const STOP = new Set(['this', 'that', 'with', 'from', 'into', 'when', 'then', 'than', 'have', 'make', 'should', 'would', 'could', 'please', 'there', 'their', 'what', 'which', 'about', 'feat', 'test', 'tests', 'code', 'file', 'files', 'change', 'update']);

function git(cwd: string, args: string[]): string | undefined {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024 * 1024 });
    return result.status === 0 ? result.stdout.trim() : undefined;
}
