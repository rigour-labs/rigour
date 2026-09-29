/**
 * Asks the local model the one thing code cannot say: is a read optional?
 *
 * Flipped-question protocol: each read gets two questions of opposite
 * polarity ("should it still return if X fails?" / "is X required?"). An
 * answer counts only when both agree (yes/no = optional, no/yes = required);
 * anything else is unknown, and unknown never becomes a finding. A finding
 * needs one read judged optional and another judged required at the same
 * site: then the optional read's failure takes down the required one.
 */
import type { InferenceProvider } from '../../inference/types.js';
import { lineOf } from '../ast.js';
import type { SemanticFinding } from '../types.js';
import type { ParallelRead, ParallelReadSite } from './parallel-reads.js';

export type Answer = 'yes' | 'no' | null;
export type Verdict = 'optional' | 'required' | 'unknown';

export interface YesNoModel {
    ask(prompt: string): Promise<Answer>;
}

export interface ReadVerdict {
    read: ParallelRead;
    verdict: Verdict;
    answers: [Answer, Answer];
}

export const RULE_ID = 'optional-read-no-fallback';
const MAX_SOURCE_LINES = 80;

export const YES_NO_SCHEMA = {
    type: 'object',
    properties: { answer: { type: 'string', enum: ['yes', 'no'] } },
    required: ['answer'],
    additionalProperties: false,
};

/** A local provider as a yes/no oracle: schema-constrained, temperature 0. */
export function yesNoModel(provider: InferenceProvider): YesNoModel {
    return {
        async ask(prompt: string): Promise<Answer> {
            const text = await provider.analyze(prompt, { jsonSchema: YES_NO_SCHEMA, temperature: 0, maxTokens: 16 });
            try {
                const answer = JSON.parse(text)?.answer;
                return answer === 'yes' || answer === 'no' ? answer : null;
            } catch {
                return null;
            }
        },
    };
}

export function verdictOf([ifFails, required]: [Answer, Answer]): Verdict {
    if (ifFails === 'yes' && required === 'no') return 'optional';
    if (ifFails === 'no' && required === 'yes') return 'required';
    return 'unknown';
}

export function questionsFor(site: ParallelReadSite, read: ParallelRead): [string, string] {
    return [
        `If \`${read.label}\` throws, should \`${site.fnName}\` still return a result built from the other calls?`,
        `Is the result of \`${read.label}\` required for \`${site.fnName}\` to return anything useful?`,
    ];
}

export function promptFor(site: ParallelReadSite, question: string): string {
    const source = site.fn.getText(site.fn.getSourceFile()).split('\n').slice(0, MAX_SOURCE_LINES).join('\n');
    return [
        'You are reviewing a TypeScript function.',
        '```ts', source, '```',
        `The calls ${site.reads.map(r => `\`${r.label}\``).join(', ')} run together in \`await Promise.all([...])\`. If any of them throws, the whole Promise.all rejects.`,
        `Question: ${question}`,
        'Answer with JSON: {"answer": "yes"} or {"answer": "no"}.',
    ].join('\n');
}

export async function classifyReads(model: YesNoModel, site: ParallelReadSite): Promise<ReadVerdict[]> {
    const verdicts: ReadVerdict[] = [];
    for (const read of site.reads) {
        const [ifFails, required] = questionsFor(site, read);
        const answers: [Answer, Answer] = [await model.ask(promptFor(site, ifFails)), await model.ask(promptFor(site, required))];
        verdicts.push({ read, verdict: verdictOf(answers), answers });
    }
    return verdicts;
}

/** Findings for a site: every read judged optional, when another read is judged required. */
export function findingsFor(site: ParallelReadSite, verdicts: ReadVerdict[]): SemanticFinding[] {
    const required = verdicts.filter(v => v.verdict === 'required').map(v => `\`${v.read.label}\``);
    if (required.length === 0) return [];
    return verdicts.filter(v => v.verdict === 'optional').map(({ read }) => ({
        rule: RULE_ID,
        severity: 'medium',
        provenance: 'deep-analysis',
        file: site.file,
        line: lineOf(read.call),
        message: `\`${read.label}\` looks optional to \`${site.fnName}\`, but it runs in Promise.all with ${required.join(', ')}, so its failure also discards ${required.length > 1 ? 'them' : 'that result'}.`,
        hint: 'Give the optional read its own catch that returns a fallback (and tell the caller the result is partial), or confirm it is required.',
        evidence: [`${site.file}:${site.line} Promise.all`, 'Intent from the local model: two flipped questions answered consistently.'],
    }));
}

