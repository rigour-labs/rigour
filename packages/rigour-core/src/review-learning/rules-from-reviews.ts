/**
 * Turning reviews into rules: a frontier model rewrites each point a person made, which the pull
 * request then acted on, as the plain-language rule behind it, or says it is not a rule (a test
 * report, a status note, a one-off fix). Memory, never training: the rule is text the next judge and
 * agent read, it keeps the person's own words as evidence, and it stays a candidate until the same
 * rule recurs in two or more pull requests or a person promotes it.
 */
import crypto from 'crypto';
import type { ReviewLesson } from './lessons.js';

/** One model call: the prompt in, the answer text out, or undefined when it could not run (learning never fails on it). */
export type RuleWriter = (prompt: string) => Promise<string | undefined>;

/** Points per call: enough to share the context, few enough that every one gets an answer. */
const BATCH = 20;
const MAX_RULE = 200;

function rulesPrompt(lessons: ReviewLesson[]): string {
    const points = lessons.map(l => ({ id: l.id, pr: l.evidence[0]?.pr, file: l.file || null, said: l.text }));
    return `A team's senior reviewers teach through code review. Below are points people made in reviews of
this repository, each of which the pull request then acted on. For each point, decide whether it
teaches a rule the team would want applied to future changes, beyond this one pull request.

- If it does, write that rule as one plain imperative sentence of at most ${MAX_RULE} characters
  ("Apply every filter known before a read in the query itself."). Keep a name only when the rule is
  about that code. Give "file" when the rule is about one file, else null.
- If it is a test or check report, a status note, praise, a question, or a fix of one specific bug that
  teaches nothing general, give "rule": null.

Do not read or change any file; answer from the points alone. Your final message must be ONLY this
JSON: {"rules":[{"id":"<the point's id>","rule":"..." | null,"file":"<path>" | null}]}

Points:
${JSON.stringify(points, null, 1)}`;
}

/**
 * The points as the rules the model wrote: a point it called no rule is kept and marked so (never
 * promoted again), a point it did not answer is kept as it was (a failed call never loses evidence), and
 * the person's words stay in the evidence. A rule about a file keeps that file only when the point was already about it.
 */
export async function rulesFromReviews(lessons: ReviewLesson[], write: RuleWriter): Promise<{ lessons: ReviewLesson[]; rules: number; dropped: number; unanswered: number }> {
    const out: ReviewLesson[] = [];
    let rules = 0, dropped = 0, unanswered = 0;
    for (let i = 0; i < lessons.length; i += BATCH) {
        const batch = lessons.slice(i, i + BATCH);
        const answers = parseRules(await write(rulesPrompt(batch)));
        for (const lesson of batch) {
            const answer = answers.get(lesson.id);
            if (!answer) {
                unanswered++;
                out.push(lesson);
            } else if (!answer.rule) {
                // Kept, marked: a point the writer found no rule in is never promoted, or paid for, again.
                dropped++;
                out.push({ ...lesson, evidence: [...lesson.evidence, { kind: 'norule', pr: lesson.evidence[0]?.pr ?? 0, comment: `norule-${lesson.id}`, author: '', detail: 'the rule writer found no rule in it' }] });
            } else {
                rules++;
                const file = answer.file && answer.file === lesson.file ? lesson.file : '';
                out.push({
                    ...lesson, text: answer.rule, file,
                    id: crypto.createHash('sha256').update(`${file}\u0000${answer.rule.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}`).digest('hex').slice(0, 12),
                    evidence: lesson.evidence.map(e => ({ ...e, said: e.said ?? lesson.text })),
                });
            }
        }
    }
    return { lessons: out, rules, dropped, unanswered };
}

function parseRules(text: string | undefined): Map<string, { rule: string | null; file: string | null }> {
    const found = new Map<string, { rule: string | null; file: string | null }>();
    if (!text) return found;
    const start = text.indexOf('{"rules"') >= 0 ? text.indexOf('{"rules"') : text.indexOf('{');
    for (let end = text.lastIndexOf('}'); start >= 0 && end > start; end = text.lastIndexOf('}', end - 1)) {
        try {
            const parsed = JSON.parse(text.slice(start, end + 1));
            for (const r of Array.isArray(parsed?.rules) ? parsed.rules : []) {
                if (typeof r?.id !== 'string') continue;
                const rule = typeof r.rule === 'string' && r.rule.trim().length >= 12 ? r.rule.trim().slice(0, MAX_RULE) : null;
                found.set(r.id, { rule, file: typeof r.file === 'string' ? r.file : null });
            }
            return found;
        } catch {
            // not a whole object yet: try a shorter one
        }
    }
    return found;
}
