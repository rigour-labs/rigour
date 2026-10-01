/**
 * Self-check: the model re-reads its findings against the code and confirms
 * or withdraws each one.
 *
 * Two review passes with the reference material in different orders raise
 * recall (a finding one ordering misses, the other catches); asking again
 * whether each finding would misbehave at runtime keeps that extra recall
 * from arriving as noise.
 *
 * All of a file's findings are checked in one call: the source and reference
 * dominate the prompt, so checking finding by finding paid for them up to
 * eight times per file. A check that cannot run, or a finding the reply does
 * not mention, keeps the finding: an unavailable or vague model is not
 * evidence against it.
 */
import type { DeepFinding, InferenceOptions, InferenceProvider } from '../inference/types.js';
import type { CodeContext } from './code-context.js';

const MAX_CHECKED = 12;

const VERDICTS_SCHEMA = {
    type: 'object',
    properties: {
        verdicts: {
            type: 'array',
            items: {
                type: 'object',
                properties: { n: { type: 'integer' }, real: { type: 'boolean' }, reason: { type: 'string' } },
                required: ['n', 'real'],
            },
        },
    },
    required: ['verdicts'],
};

export interface SelfCheckResult {
    kept: DeepFinding[];
    withdrawn: number;
    failed: number;
}

export async function selfCheck(
    provider: InferenceProvider, context: CodeContext, reference: string, findings: DeepFinding[], inference: InferenceOptions,
): Promise<SelfCheckResult> {
    const checked = findings.slice(0, MAX_CHECKED);
    const unchecked = findings.slice(MAX_CHECKED);
    let verdicts: Map<number, boolean>;
    try {
        verdicts = parseVerdicts(await provider.analyze(checkPrompt(context, reference, checked), { ...inference, jsonSchema: VERDICTS_SCHEMA }));
    } catch {
        return { kept: findings, withdrawn: 0, failed: checked.length };
    }
    const kept = checked.filter((_, index) => verdicts.get(index + 1) !== false);
    return { kept: [...kept, ...unchecked], withdrawn: checked.length - kept.length, failed: 0 };
}

export function checkPrompt(context: CodeContext, reference: string, findings: DeepFinding[]): string {
    const listed = findings.map((f, index) => `${index + 1}. ${context.file}:${f.line}: ${f.description}`).join('\n');
    return [
        `You reported ${findings.length} defect(s) in a code review. Check each against the code before it is posted.`,
        `SOURCE (line numbers on the left):\n${context.text}`,
        reference ? `REFERENCE (not under review):\n${reference}` : '',
        `REPORTED:\n${listed}`,
        'For each one: is it a real defect, would this code misbehave at runtime or in production as described? '
        + 'Answer false if it is style, speculation about unseen callers, or already handled in the code shown. '
        + 'Respond ONLY with JSON: {"verdicts": [{"n": 1, "real": true|false, "reason": "..."}, ...]}.',
    ].filter(Boolean).join('\n\n');
}

/** Finding number → verdict; numbers the reply does not settle are absent. */
export function parseVerdicts(reply: string): Map<number, boolean> {
    const verdicts = new Map<number, boolean>();
    const json = reply.slice(reply.indexOf('{'), reply.lastIndexOf('}') + 1);
    try {
        const list = JSON.parse(json).verdicts;
        if (!Array.isArray(list)) return verdicts;
        for (const item of list) {
            if (Number.isInteger(item?.n) && typeof item?.real === 'boolean') verdicts.set(item.n, item.real);
        }
    } catch {
        // Not a verdict list: nothing is withdrawn.
    }
    return verdicts;
}
