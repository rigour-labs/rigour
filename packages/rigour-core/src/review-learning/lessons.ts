/**
 * Review lessons: what a team's reviews taught, ready to hand to the next agent
 * and judge.
 *
 * Evidence only. Every review point, a person's, an AI's posted under a person's
 * login, or a bot's, is a candidate; who wrote it is recorded, never the gate. A
 * candidate becomes a lesson on evidence (lessonState): an outcome (a later fix
 * to the lines it pointed at), a person accepting it, or, weak alone, the same
 * point recurring across pull requests by different authors. Counter-evidence (the
 * lines shipped unchanged and nothing needed fixing within a window) holds it
 * back, and a person rejecting it makes it an anti-lesson the judges are told is
 * settled. Every piece of evidence stays on the lesson. Lessons stay in the
 * repository's .rigour/ folder and are sent nowhere except to the user's own model.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Git, ReviewBody, ReviewComment } from './acted-on.js';
import { bodyPoints, withoutEmphasis } from './review-points.js';
import { asksSomething, bodyPointPlaces, describesChange, notARequest, type NotRequestReason } from './requests.js';

const STORE = path.join('.rigour', 'review-lessons.json');
const MAX_TEXT = 220;
const MAX_SYMBOLS = 8;
/**
 * Recurrence is weak evidence, and only when independent: the same point on this many pull requests,
 * by this many different authors, raised by different reviewers or by one person in different words
 * (a senior re-raising a standard counts; a bot rewording its own point on every pull request does not).
 */
const RECUR_PRS = 2;
const RECUR_AUTHORS = 2;
/** One reviewer raising a point again is a standard only across this many pull requests, this many days apart. */
const ONE_REVIEWER_PRS = 3;
const ONE_REVIEWER_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
/** A person's keeping of a verified lesson: its reach, its wording, a check compiled from it. Recurrence never takes those back. */
const KEPT_BY_A_PERSON = new Set<EvidenceKind>(['scoped', 'reworded', 'compiled']);
/** Team standards served with a change, on top of the lessons about its files (an agent's question; a judge takes more), and the words they must share with it. */
const MAX_STANDARDS = 3;
/** Repository standards (scope `repo`) served with every change, most-raised first. */
const REPO_STANDARDS = 10;
const STANDARD_WORDS = 2;
/** Words that say nothing about what a rule or a change is about. */
const PLAIN_WORDS = new Set(['when', 'that', 'this', 'with', 'from', 'before', 'after', 'every', 'their', 'them', 'than', 'each', 'only', 'into', 'rather', 'instead', 'should', 'make', 'keep', 'sure', 'does', 'what', 'which', 'there', 'these', 'those', 'such', 'more', 'other', 'same', 'then', 'also', 'both', 'must', 'never', 'always', 'once', 'been', 'have', 'will', 'your', 'about', 'over', 'under', 'change', 'changes', 'code', 'value', 'values', 'data', 'true', 'false', 'null', 'undefined', 'return', 'const', 'function', 'export', 'import', 'await', 'async', 'string', 'number', 'type']);
/** Lessons from these teach about one document, test or config file, not about code that will change again. */
const NOT_CODE = /(\.(md|mdx|txt|ya?ml|json|lock|snap)$)|(\.(test|spec)\.[cm]?[jt]sx?$)|(^|\/)(__tests__|docs?|migrations|\.github)\//i;
const NOT_SYMBOLS = new Set(['this', 'that', 'with', 'from', 'return', 'const', 'await', 'async', 'function', 'true', 'false', 'null', 'undefined', 'string', 'number', 'boolean', 'export', 'import', 'type', 'interface', 'else', 'when', 'then', 'should', 'line', 'lines']);

/**
 * One piece of a lesson's evidence trail:
 *   point     a review point making it (the candidate's own source; weak, but it can recur);
 *   outcome   a later commit fixed the lines the point named, or the pull request was reverted;
 *   counter   the lines shipped unchanged and nothing needed fixing within the window;
 *   correction  a person changed what an agent wrote (human-edits.ts): heavily weighted, it makes a lesson;
 *   accepted / rejected   a person decided (`rigour learn-reviews --promote / --reject`);
 *   norule    the rule writer found no rule in it (a report, a template, a one-off): never promoted again;
 *   followup  a later fix touched the point's file, with nothing else to show it was this point (outcome-evidence.ts):
 *             recorded, never enough on its own;
 *   lines     a later fix changed the point's own lines (outcome-evidence.ts): shown for a person to promote or dismiss,
 *             never a promotion on its own (a fix on the same lines is often unrelated work);
 *   dismissed a person looked at that evidence and set it aside: the lesson stays as it was;
 *   reclassified  a lesson an outcome alone had promoted, back to a candidate when outcomes stopped promoting (once);
 *   against   a later pull request a review found repeating the lesson merged anyway and settled clean;
 *   demoted   enough independent `against` pull requests took back a lesson evidence had promoted: a candidate again,
 *             until a person promotes it.
 * A record from before evidence kinds has none: it is a `point`.
 */
export type EvidenceKind = 'point' | 'outcome' | 'counter' | 'correction' | 'accepted' | 'rejected' | 'norule' | 'followup' | 'lines' | 'dismissed' | 'against' | 'demoted' | 'reclassified' | 'compiled' | 'reworded' | 'scoped';

export interface LessonEvidence {
    kind?: EvidenceKind;
    pr: number;
    /** The review comment or review-body point (or, for a decision, what decided it). */
    comment: string;
    /** Who wrote the point, or who decided. */
    author: string;
    /** A review bot's login (a GitHub App), or a person's (whose text may itself be an AI's): metadata, never a gate. */
    source?: 'person' | 'bot';
    /** Who wrote the pull request: recurrence counts only across different authors. */
    prAuthor?: string;
    /** Whether the pull request changed the lines before merging: not evidence (agents apply comments on their own), recorded. */
    actedOn?: boolean;
    /** The comment was edited at or after `--until`: GitHub serves only its edited text, so this point may say more than it did then. */
    editedAfterUntil?: true;
    /** When the point was posted on GitHub (not when it was learned, which is `at`): how far apart one reviewer's points are. */
    postedAt?: string;
    /** The person's own words, kept when a rule was written from them (rules-from-reviews.ts). */
    said?: string;
    /** A point's own words, as it was made (each point merged into a lesson keeps its own). */
    text?: string;
    /** What the evidence was: the fixing commit, the window, who decided and why. */
    detail?: string;
    at?: string;
}

export interface ReviewLesson {
    id: string;
    text: string;
    file: string;
    symbols: string[];
    /** `rejected`: an anti-lesson, a point the team decided against. */
    state: 'candidate' | 'verified' | 'rejected';
    /** Which evidence made it a lesson. */
    promotedBy?: 'outcome' | 'correction' | 'person' | 'recurrence' | 'legacy';
    /**
     * How far a person widened it (scopeLesson): `folder`, every change in the lesson's folder; `repo`, every change,
     * a standard for the whole repository. Absent: its file (or, with no file, a standard served by its words).
     */
    scope?: 'folder' | 'repo';
    evidence: LessonEvidence[];
    /**
     * A corrected wording a newer version derived from the lesson's own comment, waiting for a person. A lesson
     * a person decided keeps the wording they decided on until they take this one (acceptSuggestedText).
     */
    suggestedText?: string;
    /** Why there is a suggestion: `parser fix`, a newer version reading the comment better. */
    suggestedWhy?: string;
    /** Where the point sits in the commit it was made on, for outcome evidence (inline comments only). */
    at?: { commit: string; start: number; end: number };
    createdAt: string;
    updatedAt: string;
}

/**
 * A lesson's state from its evidence trail. A person's decision wins; then a person's correction; counter-evidence
 * holds a candidate back; recurrence across pull requests and authors is enough only without it. An outcome is
 * evidence, never a promotion. A record from before evidence kinds keeps the state it had.
 */
export function lessonState(lesson: ReviewLesson): Pick<ReviewLesson, 'state' | 'promotedBy'> {
    const kinds = new Set(lesson.evidence.map(e => e.kind));
    if (!lesson.evidence.some(e => e.kind)) return lesson.state === 'verified' ? { state: 'verified', promotedBy: lesson.promotedBy ?? 'legacy' } : { state: lesson.state };
    const decisions = lesson.evidence.filter(e => e.kind === 'accepted' || e.kind === 'rejected');
    const last = decisions.at(-1);
    if (last?.kind === 'rejected') return { state: 'rejected' };
    if (last?.kind === 'accepted') return { state: 'verified', promotedBy: 'person' };
    if (kinds.has('norule')) return { state: 'candidate' };
    // Taken back by evidence (outcome-evidence.ts): a person's decision above is the only way back.
    if (kinds.has('demoted')) return { state: 'candidate' };
    if (kinds.has('correction')) return { state: 'verified', promotedBy: 'correction' };
    // An outcome (a later fix on the point's lines, a revert) no longer promotes on its own: judged by a person against
    // real history, it was most often unrelated work. It is shown in Studio for a person to promote.
    if (kinds.has('counter')) return { state: 'candidate' };
    // A lesson is never verified without a person: review bots agreeing with each other are not a team's standard.
    if (raisedOnlyByBots(lesson)) return { state: 'candidate' };
    if (!whyNotRecurring(lesson)) return { state: 'verified', promotedBy: 'recurrence' };
    // A person who kept a verified lesson (its reach, its wording, a compiled check) decided; the rule does not undo it.
    if (lesson.state === 'verified' && lesson.evidence.some(e => e.kind && KEPT_BY_A_PERSON.has(e.kind))) return { state: 'verified', promotedBy: lesson.promotedBy };
    return { state: 'candidate' };
}

/**
 * Why recurrence does not make this lesson a standard, in the rule's own words; undefined when it does. Only people's
 * points count: on two or more pull requests by different authors, raised by a second reviewer, or by one reviewer on
 * at least ONE_REVIEWER_PRS pull requests ONE_REVIEWER_DAYS or more apart (when each point was posted).
 */
function whyNotRecurring(lesson: ReviewLesson): string | undefined {
    const people = lesson.evidence.filter(e => (e.kind ?? 'point') === 'point' && e.source !== 'bot');
    if (people.length === 0) return BOTS_ONLY;
    const prs = new Set(people.map(e => e.pr)).size;
    if (prs < RECUR_PRS) return `raised by people on ${prs} pull request; needs ${RECUR_PRS} or more`;
    if (new Set(people.map(e => e.prAuthor).filter(Boolean)).size < RECUR_AUTHORS) return `raised on pull requests by one author; needs ${RECUR_AUTHORS} or more authors`;
    if (new Set(people.map(e => e.author).filter(Boolean)).size >= 2) return undefined;
    const needs = `needs ≥${ONE_REVIEWER_PRS} PRs over ≥${ONE_REVIEWER_DAYS} days or a second reviewer`;
    const times = people.map(e => Date.parse(e.postedAt ?? ''));
    if (times.some(Number.isNaN)) return `one reviewer, ${prs} PRs, when they were posted not recorded; ${needs}`;
    const days = Math.floor((Math.max(...times) - Math.min(...times)) / DAY_MS);
    return prs >= ONE_REVIEWER_PRS && days >= ONE_REVIEWER_DAYS ? undefined : `one reviewer, ${prs} PRs over ${days} days; ${needs}`;
}

/** Every point on the lesson came from a review bot: it is recorded, but never verified or served until a person decides. */
export function raisedOnlyByBots(lesson: ReviewLesson): boolean {
    const points = lesson.evidence.filter(e => (e.kind ?? 'point') === 'point');
    return points.length > 0 && points.every(e => e.source === 'bot');
}

/** A sentence that tells the author what to do, not only what is wrong. */
const INSTRUCTION = /^(?:please\s+)?(?:use|pick|avoid|don'?t|do not|never|always|make|keep|move|read|filter|check|change|drop|add|remove|pass|split|prefer|replace|rename|derive|select|return|validate|extract|bound|lock)\b|\b(?:should|must|instead)\b/i;

/**
 * The point of a review comment: its bold title, else its first sentence and, when that only says what is
 * wrong, the first later sentence that says what to do. Without tool output or markup.
 */
export function lessonText(body: string): string {
    const cleaned = body
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<details>[\s\S]*?<\/details>/g, '')
        .replace(/```[\s\S]*?```/g, '')
        .split('\n')
        .filter(line => !/^\s*(_[^_]+_\s*\|?\s*)+$/.test(line) && !/^\s*[🏁💡🧩🔇🧰📝⚠️🛠️]/u.test(line))
        .filter(line => !/^\s*#*\s*\**\s*(low|medium|high|critical)\s+severity\s*\**\s*$/i.test(line))
        .join('\n');
    const bold = /\*\*(.+?)\*\*/.exec(cleaned)?.[1]?.trim();
    const sentences = cleaned.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s/);
    const instruction = INSTRUCTION.test(sentences[0] ?? '') ? undefined : sentences.slice(1).find(s => INSTRUCTION.test(s));
    const text = bold || [sentences[0] ?? '', instruction ?? ''].filter(Boolean).join(' ');
    return pointText(withoutEmphasis(text)).slice(0, MAX_TEXT).trim();
}

/**
 * A point's words without a review bot's scaffolding (`In src/a.ts around lines 10-12:`), or '' when
 * nothing but a path or a location is left: a file name alone teaches nothing.
 */
function pointText(text: string): string {
    const bare = text.trim().replace(/^(in\s+\S+\s+)?around\s+lines?\s+[\d\s,–-]+:\s*/i, '').trim();
    return /^[`'"]?[\w@.~/[\]()+-]+[`'"]?:?$/.test(bare) ? '' : bare;
}

/** Identifiers a lesson is about: those the comment names, then those on the lines it pointed at. */
export function lessonSymbols(body: string, codeLines: string[]): string[] {
    const named = [...body.matchAll(/`([A-Za-z_$][\w$.]*)`/g)].map(m => m[1].split('.').pop()!);
    const onLines = codeLines.join('\n').match(/[A-Za-z_$][\w$]{3,}/g) ?? [];
    const symbols: string[] = [];
    for (const symbol of [...named, ...onLines]) {
        if (!NOT_SYMBOLS.has(symbol.toLowerCase()) && !symbols.includes(symbol)) symbols.push(symbol);
        if (symbols.length >= MAX_SYMBOLS) break;
    }
    return symbols;
}

/** Told why a point asking for nothing was skipped (requests.ts), so learning can count it. */
export type OnSkip = (reason: NotRequestReason) => void;

export function lessonFromComment(git: Git, comment: ReviewComment, at = new Date().toISOString(), onSkip?: OnSkip): ReviewLesson | undefined {
    const text = lessonText(comment.body);
    if (text.length < 12) return undefined;
    const skip = notARequest(text, 'inline');
    if (skip) {
        onSkip?.(skip);
        return undefined;
    }
    let codeLines: string[] = [];
    try {
        codeLines = git(['show', `${comment.commit}:${comment.path}`]).split('\n').slice(comment.start - 1, comment.end);
    } catch {
        // The file at that commit is unavailable: the comment's own identifiers still describe it.
    }
    return {
        id: crypto.createHash('sha256').update(`${comment.path}\u0000${normalize(text)}`).digest('hex').slice(0, 12),
        text, file: comment.path, symbols: lessonSymbols(comment.body, codeLines), state: 'candidate',
        evidence: [{ kind: 'point', pr: comment.prNumber, comment: comment.id, author: comment.author, ...pointMeta(comment), text, at }],
        at: { commit: comment.commit, start: comment.start, end: comment.end }, createdAt: at, updatedAt: at,
    };
}

/**
 * Candidate lessons from a review body's points. A point naming a path is about that file; one naming
 * only a file the PR changed after the review (by its name) is about that file; a point naming none is
 * a team standard (file ''), served with any change it is about once evidence makes it a lesson.
 * Whether files changed after it is recorded, not required.
 */
export function lessonsFromReview(review: ReviewBody, changedAfter: string[], at = new Date().toISOString(), onSkip?: OnSkip): ReviewLesson[] {
    const places = bodyPointPlaces(review.body);
    return bodyPoints(review.body).flatMap((point, i) => {
        const text = pointText(withoutEmphasis(point)).slice(0, MAX_TEXT).trim();
        if (text.length < 12) return [];
        // The point's own shape first (a tool's status line is that wherever it sits); then its place: a tool's help
        // block is never review, and a change summary's bullet is a description unless it asks for something. A
        // person's "## Summary" often lists defects as plain statements, so there the bullet must also read as a
        // description; in a bot's body the place is enough.
        const own = notARequest(point, 'body');
        const summarised = places[i] === 'describes the change' && !asksSomething(point) && (review.source === 'bot' || describesChange(point));
        const placed = places[i] === 'review tool status' || summarised ? places[i] : undefined;
        const skip = own === 'review tool status' ? own : placed ?? own;
        if (skip) {
            onSkip?.(skip);
            return [];
        }
        const named = /(?:^|[\s`(])((?:[\w.-]+\/)+[\w.-]+\.\w+)/.exec(point)?.[1];
        const file = named ?? changedAfter.find(f => text.includes(path.posix.basename(f))) ?? '';
        return [{
            id: crypto.createHash('sha256').update(`${file}\u0000${normalize(text)}`).digest('hex').slice(0, 12),
            text, file, symbols: lessonSymbols(point, []), state: 'candidate' as const,
            evidence: [{ kind: 'point' as const, pr: review.prNumber, comment: `review-${review.id}-${i}`, author: review.author, ...pointMeta(review), actedOn: changedAfter.length > 0, text, at }], createdAt: at, updatedAt: at,
        }];
    });
}

/**
 * Add lessons to the store. The same lesson again (isSameLesson: the same text, the same review
 * comment, or the same file with two shared symbols) adds evidence; acted on in enough PRs, it is
 * verified.
 */
export function mergeLessons(existing: ReviewLesson[], incoming: ReviewLesson[]): { lessons: ReviewLesson[]; added: number; verified: number } {
    const lessons = existing.map(l => ({ ...l, evidence: [...l.evidence] }));
    let added = 0;
    for (const lesson of incoming) {
        const same = lessons.find(l => isSameLesson(l, lesson));
        if (!same) {
            lessons.push({ ...lesson, evidence: [...lesson.evidence] });
            added++;
            continue;
        }
        for (const e of lesson.evidence) if (!same.evidence.some(x => x.comment === e.comment && x.kind === e.kind)) same.evidence.push(e);
        refreshText(same, lesson);
        same.updatedAt = lesson.updatedAt;
    }
    let verified = 0;
    for (const lesson of lessons) {
        const before = lesson.state;
        Object.assign(lesson, lessonState(lesson));
        if (lesson.state === 'verified' && before !== 'verified') verified++;
    }
    return { lessons, added, verified };
}

/** Whether a lesson carries the review point `point` (the same comment on the same pull request). */
function hasPoint(lesson: ReviewLesson, point: LessonEvidence): boolean {
    return lesson.evidence.some(x => x.kind === 'point' && x.pr === point.pr && x.comment === point.comment);
}

/** A person accepted, rejected or dismissed it, or approved or took back a check compiled from it. */
function decidedByPerson(lesson: ReviewLesson): boolean {
    return lesson.evidence.some(e => e.kind === 'accepted' || e.kind === 'rejected' || e.kind === 'dismissed' || e.kind === 'compiled');
}

/**
 * Re-read from the comment it was learned from, an undecided lesson takes the text this version derives; its id
 * and evidence stay. One a person decided keeps the wording they decided on, and the new one waits as a
 * suggestion for them. A later comment merged into a lesson never rewrites it.
 */
function refreshText(stored: ReviewLesson, lesson: ReviewLesson): void {
    const origin = stored.evidence.find(e => e.kind === 'point');
    if (stored.id === lesson.id || !origin || !hasPoint(lesson, origin)) return;
    if (lesson.text === stored.text) {
        delete stored.suggestedText;
        delete stored.suggestedWhy;
    } else if (decidedByPerson(stored)) {
        stored.suggestedText = lesson.text;
        stored.suggestedWhy = 'parser fix';
    } else stored.text = lesson.text;
}

/**
 * The same lesson: the same id; the same review comment read again, whatever text an earlier version took from it;
 * shared names on another pull request (two points on one pull request are two points); or a team standard in the
 * same words.
 */
function isSameLesson(stored: ReviewLesson, lesson: ReviewLesson): boolean {
    if (stored.id === lesson.id) return true;
    if (stored.evidence.some(e => e.kind === 'point' && hasPoint(lesson, e))) return true;
    const otherPr = !stored.evidence.some(e => lesson.evidence.some(x => x.pr === e.pr));
    if (stored.file === lesson.file && shared(stored.symbols, lesson.symbols) >= 2 && otherPr) return true;
    return !stored.file && !lesson.file && sameWords(stored.text, lesson.text);
}

export interface ChangeShape {
    files: string[];
    /** Identifiers in the changed code. */
    symbols: Set<string>;
}

/**
 * Lessons that apply to a change, best first. A lesson applies when the change
 * touches its file, or shares at least two specific identifiers with it; a
 * shared directory only breaks ties. Lessons about docs, tests or config never
 * apply to other files. A team standard (a lesson with no file) applies to every
 * change; the best-evidenced few follow the file lessons.
 */
export function matchLessons(lessons: ReviewLesson[], change: ChangeShape, options: { includeCandidates?: boolean; limit?: number; standards?: number; perFile?: number; excludePr?: number } = {}): ReviewLesson[] {
    // A lesson whose only evidence is the pull request under review is already in front of the judge as the reviewer's own points.
    if (options.excludePr !== undefined) lessons = lessons.filter(l => !l.evidence.length || l.evidence.some(e => e.pr !== options.excludePr));
    const inPlay = (l: ReviewLesson) => l.state === 'verified' || (!!options.includeCandidates && l.state === 'candidate' && !raisedOnlyByBots(l));
    // A person made these the repository's standards: every change gets them, whatever its files or words; most-raised first.
    const repo = lessons
        .filter(l => l.scope === 'repo' && inPlay(l))
        .sort((a, b) => prCount(b) - prCount(a) || b.evidence.length - a.evidence.length)
        .slice(0, REPO_STANDARDS);
    lessons = lessons.filter(l => l.scope !== 'repo');
    const dirs = new Set(change.files.map(f => path.posix.dirname(f)));
    const inFolder = (l: ReviewLesson) => l.scope === 'folder' && change.files.some(f => f.startsWith(`${path.posix.dirname(l.file)}/`));
    const scored = lessons
        .filter(l => !!l.file && inPlay(l) && !NOT_CODE.test(l.file))
        .map(l => ({
            lesson: l,
            score: (change.files.includes(l.file) || inFolder(l) ? 3 : 0) + (dirs.has(path.posix.dirname(l.file)) ? 0.5 : 0)
                + 2 * l.symbols.filter(s => isSpecific(s) && change.symbols.has(s)).length,
        }))
        .filter(s => s.score >= 3)
        .sort((a, b) => b.score - a.score || b.lesson.evidence.length - a.lesson.evidence.length);
    // A team standard (no file) applies when its words are the change's: its paths and the names on its added lines,
    // split into words. A rule about keyboard shortcuts says nothing to a change to a database job.
    const changeWords = new Set([...change.files.flatMap(f => f.split(/[/._-]+/)), ...change.symbols].flatMap(meaningfulWords));
    const standards = lessons
        .filter(l => !l.file && (l.state === 'verified' || (options.includeCandidates && l.state === 'candidate')))
        .map(l => ({ lesson: l, shared: new Set(meaningfulWords(l.text)).size === 0 ? 0 : [...new Set(meaningfulWords(l.text))].filter(w => changeWords.has(w)).length }))
        .filter(s => s.shared >= STANDARD_WORDS)
        .sort((a, b) => b.shared - a.shared || b.lesson.evidence.length - a.lesson.evidence.length)
        .slice(0, options.standards ?? MAX_STANDARDS)
        .map(s => s.lesson);
    // On a large change, one file's many lessons must not crowd out another file's only one: a cap per file, then the total.
    const perFile = options.perFile ?? Infinity;
    const taken: ReviewLesson[] = [];
    const perFileCount = new Map<string, number>();
    for (const { lesson } of scored) {
        if (taken.length >= (options.limit ?? 5)) break;
        const n = perFileCount.get(lesson.file) ?? 0;
        if (n >= perFile) continue;
        perFileCount.set(lesson.file, n + 1);
        taken.push(lesson);
    }
    return [...taken, ...repo, ...standards];
}

/** Pull requests a lesson was raised or acted on in. */
function prCount(lesson: ReviewLesson): number {
    return new Set(lesson.evidence.filter(e => (e.kind ?? 'point') === 'point').map(e => e.pr)).size;
}

/**
 * A person sets how far a lesson reaches: `repo` (every change), `folder` (every change in its folder) or `file` (its
 * own file, as learned). Recorded as evidence with who and why; it says nothing about whether the lesson is right.
 */
export function scopeLesson(cwd: string, id: string, scope: 'file' | 'folder' | 'repo', by: string, why = ''): ReviewLesson | undefined {
    return updateLessons(cwd, lessons => {
        const lesson = lessons.find(l => l.id === id);
        if (!lesson) return undefined;
        if (scope === 'folder' && !lesson.file) throw new Error('a team standard has no folder: scope it to the repo or leave it');
        const at = new Date().toISOString();
        if (scope === 'file') delete lesson.scope;
        else lesson.scope = scope;
        lesson.evidence.push({ kind: 'scoped', pr: lesson.evidence[0]?.pr ?? 0, comment: `scoped-${at}`, author: by, detail: why ? `${scope}: ${why}` : scope, at });
        lesson.updatedAt = at;
        return lesson;
    });
}

/** RIGOUR_REVIEW_LESSONS points at a lessons file outside the clone (CI, or a team's shared copy). */
export function lessonsPath(cwd: string): string {
    return process.env.RIGOUR_REVIEW_LESSONS?.trim() || path.join(cwd, STORE);
}

export function readLessons(cwd: string): ReviewLesson[] {
    try {
        const parsed = JSON.parse(fs.readFileSync(lessonsPath(cwd), 'utf8'));
        return Array.isArray(parsed?.lessons) ? parsed.lessons.map(reclassified) : [];
    } catch {
        return [];
    }
}

/**
 * What a person is asked to decide on a candidate, from the last of its evidence and decisions: taken back by evidence
 * (`demoted`), back to a candidate when outcomes stopped promoting (`reclassified`), or a later fix on its lines
 * (`lines`); undefined when nothing waits on a person. Studio and the outcome numbers read it, so they never disagree.
 */
export function pendingDecision(lesson: ReviewLesson): LessonEvidence | undefined {
    if (lesson.state !== 'candidate') return undefined;
    const last = lesson.evidence.filter(e => e.kind === 'demoted' || e.kind === 'lines' || e.kind === 'reclassified' || e.kind === 'accepted' || e.kind === 'rejected' || e.kind === 'dismissed').at(-1);
    return last?.kind === 'demoted' || last?.kind === 'lines' || last?.kind === 'reclassified' ? last : undefined;
}

/**
 * A candidate only review bots raised: hidden from the default lists (`--list`, Studio) and counted instead. Who
 * raised it comes only from its review points: outcome evidence (a later fix on its lines) never makes it a
 * person's. One taken back or reclassified stays in view, so the reason a lesson went back is seen.
 */
export function quietBotCandidate(lesson: ReviewLesson): boolean {
    const pending = pendingDecision(lesson);
    return lesson.state === 'candidate' && raisedOnlyByBots(lesson) && (!pending || pending.kind === 'lines');
}

/** Why a lesson an outcome alone had promoted is a candidate again. */
const RECLASSIFIED = 'promoted by the exact-line rule, which no longer promotes on its own';
/** Why a lesson recurrence had promoted on review bots' points alone is a candidate again. */
const BOTS_ONLY = 'only review bots raised it (no person)';

/**
 * A lesson stored as verified by a rule that no longer promotes on its own, as every reader sees it now: an outcome
 * (a later fix on its lines, or a revert), or recurrence on review bots' points alone. Its state is worked out again
 * from its evidence, and, when that leaves it a candidate, one `reclassified` record says why. Never deleted, nothing
 * else changed; the next write keeps it, and a lesson that already has the record is left as it is. Recurrence with a
 * person's point, a correction or a person's decision keeps a lesson verified.
 */
function reclassified(lesson: ReviewLesson): ReviewLesson {
    const byRecurrence = lesson.promotedBy === 'recurrence';
    if (lesson.state !== 'verified' || !(lesson.promotedBy === 'outcome' || byRecurrence) || lesson.evidence.some(e => e.kind === 'reclassified')) return lesson;
    const next = lessonState(lesson);
    if (next.state === 'verified') return { ...lesson, ...next };
    const at = new Date().toISOString();
    const detail = byRecurrence ? whyNotRecurring(lesson) ?? RECLASSIFIED : RECLASSIFIED;
    return { ...lesson, state: 'candidate', promotedBy: undefined, evidence: [...lesson.evidence, { kind: 'reclassified', pr: lesson.evidence[0]?.pr ?? 0, comment: `reclassified-${lesson.id}`, author: '', detail, at }] };
}

/** How long a writer waits for another to finish, and when a lock is taken as left by a writer that died. */
const LOCK_WAIT_MS = 10_000;
const LOCK_STALE_MS = 30_000;
const LOCK_POLL_MS = 25;

/**
 * Runs `work` holding the store's lock (`<store>.lock`, created exclusively). A writer holds it only to read, change
 * and write the file, so a lock older than LOCK_STALE_MS was left by a writer that died, and is taken over. Waits at
 * most LOCK_WAIT_MS for another writer, then throws, so a decision is never silently lost.
 */
function withStoreLock<T>(cwd: string, work: () => T): T {
    const file = lessonsPath(cwd);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const lock = `${file}.lock`;
    const until = Date.now() + LOCK_WAIT_MS;
    for (;;) {
        try {
            fs.closeSync(fs.openSync(lock, 'wx'));
            break;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            if (Date.now() > until) throw new Error(`the review lessons store is locked by another writer (${lock}); try again`);
            const age = Date.now() - (fs.statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
            if (age > LOCK_STALE_MS) { fs.rmSync(lock, { force: true }); continue; }
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_POLL_MS);
        }
    }
    try {
        return work();
    } finally {
        fs.rmSync(lock, { force: true });
    }
}

/** Writes the whole store at once: a reader sees the old file or the new one, never half of one. */
function writeStore(cwd: string, lessons: ReviewLesson[]): void {
    const file = lessonsPath(cwd);
    const temp = `${file}.${process.pid}.tmp`;
    try {
        fs.writeFileSync(temp, JSON.stringify({ version: 1, lessons }, null, 2) + '\n');
        fs.renameSync(temp, file);
    } finally {
        fs.rmSync(temp, { force: true });
    }
}

/**
 * Reads the store, applies `change` and writes it, under the lock: two writers (a decision in Studio, a CLI run, a team
 * sync) never overwrite each other. For short changes only; work that takes long (a model call, a git walk) reads,
 * works, and writes with writeLessons(cwd, lessons, read).
 */
export function updateLessons<T>(cwd: string, change: (lessons: ReviewLesson[]) => T): T {
    return withStoreLock(cwd, () => {
        const lessons = readLessons(cwd);
        const result = change(lessons);
        writeStore(cwd, lessons);
        return result;
    });
}

/**
 * Writes the store from `read` (the lessons as this writer read them before working) and `lessons` (what it made of
 * them). What another writer changed in the meantime is kept: every lesson and every piece of evidence either side
 * added (nothing is ever removed), and for each other field, this writer's value only where it changed it. The state is
 * then worked out again from the evidence. There is no blind overwrite.
 */
export function writeLessons(cwd: string, lessons: ReviewLesson[], read: ReviewLesson[]): void {
    withStoreLock(cwd, () => writeStore(cwd, mergeConcurrent(read, lessons, readLessons(cwd))));
}

/** Three-way: `ours` was made from `base`; `theirs` is the store now. */
function mergeConcurrent(base: ReviewLesson[], ours: ReviewLesson[], theirs: ReviewLesson[]): ReviewLesson[] {
    const before = new Map(base.map(l => [l.id, l]));
    const now = new Map(theirs.map(l => [l.id, l]));
    const merged = ours.map(mine => {
        const current = now.get(mine.id);
        now.delete(mine.id);
        if (!current) return mine;
        const was = before.get(mine.id);
        const result: ReviewLesson = { ...current };
        const fields = new Set([...Object.keys(mine), ...Object.keys(was ?? {})]) as Set<keyof ReviewLesson>;
        for (const key of fields) {
            if (key === 'evidence' || JSON.stringify(mine[key]) === JSON.stringify(was?.[key])) continue;
            if (mine[key] === undefined) delete result[key];
            else (result as unknown as Record<string, unknown>)[key] = mine[key];
        }
        result.evidence = [...current.evidence, ...mine.evidence.filter(e => !current.evidence.some(x => x.kind === e.kind && x.comment === e.comment))];
        return { ...result, ...lessonState(result) };
    });
    return [...merged, ...now.values()];
}

/** A person's decision on a lesson, kept as evidence: accepted makes it a lesson, rejected an anti-lesson. Undefined for an unknown id. */
export function decideLesson(cwd: string, id: string, decision: 'accepted' | 'rejected' | 'dismissed', by: string, why = ''): ReviewLesson | undefined {
    return updateLessons(cwd, lessons => {
        const lesson = lessons.find(l => l.id === id);
        if (!lesson) return undefined;
        const at = new Date().toISOString();
        lesson.evidence.push({ kind: decision, pr: lesson.evidence[0]?.pr ?? 0, comment: `${decision}-${at}`, author: by, detail: why, at });
        Object.assign(lesson, lessonState(lesson), { updatedAt: at });
        return lesson;
    });
}

/** A person takes a decided lesson's suggested wording; who and the wording it replaced are kept as evidence. */
export function acceptSuggestedText(cwd: string, id: string, by: string): ReviewLesson | undefined {
    return updateLessons(cwd, lessons => {
        const lesson = lessons.find(l => l.id === id);
        if (!lesson?.suggestedText) return undefined;
        const at = new Date().toISOString();
        lesson.evidence.push({ kind: 'reworded', pr: lesson.evidence[0]?.pr ?? 0, comment: `reworded-${at}`, author: by, detail: `${lesson.suggestedWhy ?? 'reworded'}; was: ${lesson.text}`, at });
        lesson.text = lesson.suggestedText;
        delete lesson.suggestedText;
        delete lesson.suggestedWhy;
        lesson.updatedAt = at;
        return lesson;
    });
}

/** An identifier specific enough to link two pieces of code: camelCase, snake_case, or long. */
export function isSpecific(symbol: string): boolean {
    return /[a-z][A-Z]|[A-Za-z]_[A-Za-z]/.test(symbol) || symbol.length >= 10;
}

function normalize(text: string): string {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function shared(a: string[], b: string[]): number {
    return a.filter(s => b.includes(s)).length;
}

/** Two team standards are the same point when most of their words are: a reviewer rarely repeats a sentence exactly. */
function sameWords(a: string, b: string): boolean {
    const words = (t: string) => new Set(normalize(t).split(' ').filter(w => w.length >= 4));
    const x = words(a), y = words(b);
    if (x.size === 0 || y.size === 0) return false;
    const common = [...x].filter(w => y.has(w)).length;
    return common / Math.max(x.size, y.size) >= 0.6;
}

/** The meaningful words of a text or an identifier: `hasLaterAttempt` and "a later attempt" share later and attempt. */
export function meaningfulWords(text: string): string[] {
    return text.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z]+/).filter(w => w.length >= 4 && !PLAIN_WORDS.has(w));
}

/** Who made a point and on whose pull request: recorded with it, never a filter. */
function pointMeta(x: { source?: 'person' | 'bot'; prAuthor?: string; actedOn?: boolean; editedAfterUntil?: true; postedAt?: string }): Pick<LessonEvidence, 'source' | 'prAuthor' | 'actedOn' | 'editedAfterUntil' | 'postedAt'> {
    return { ...(x.source ? { source: x.source } : {}), ...(x.prAuthor ? { prAuthor: x.prAuthor } : {}), ...(x.actedOn !== undefined ? { actedOn: x.actedOn } : {}), ...(x.editedAfterUntil ? { editedAfterUntil: true as const } : {}), ...(x.postedAt ? { postedAt: x.postedAt } : {}) };
}
