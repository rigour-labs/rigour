/**
 * Self-check: the model re-reads each finding against the code and confirms
 * or withdraws it.
 *
 * Two review passes with the reference material in different orders raise
 * recall (a finding one ordering misses, the other catches); asking again,
 * finding by finding, whether it would misbehave at runtime keeps that extra
 * recall from arriving as noise. A check that cannot run keeps the finding:
 * an unavailable model is not evidence against it.
 */
import type { DeepFinding, InferenceOptions, InferenceProvider } from '../inference/types.js';
import type { CodeContext } from './code-context.js';

const MAX_CHECKED = 8;

const VERDICT_SCHEMA = {
    type: 'object',
    properties: { real: { type: 'boolean' }, reason: { type: 'string' } },
    required: ['real'],
};

export interface SelfCheckResult {
    kept: DeepFinding[];
    withdrawn: number;
    failed: number;
}

export async function selfCheck(
    provider: InferenceProvider, context: CodeContext, reference: string, findings: DeepFinding[], inference: InferenceOptions,
): Promise<SelfCheckResult> {
    const result: SelfCheckResult = { kept: [], withdrawn: 0, failed: 0 };
    for (const [index, finding] of findings.entries()) {
        if (index >= MAX_CHECKED) {
            result.kept.push(finding);
            continue;
        }
        try {
            const reply = await provider.analyze(checkPrompt(context, reference, finding), { ...inference, jsonSchema: VERDICT_SCHEMA });
            if (parseVerdict(reply) === false) result.withdrawn++;
            else result.kept.push(finding);
        } catch {
            result.failed++;
            result.kept.push(finding);
        }
    }
    return result;
}

export function checkPrompt(context: CodeContext, reference: string, finding: DeepFinding): string {
    return [
        'You reported a defect in a code review. Check it against the code before it is posted.',
        `SOURCE (line numbers on the left):\n${context.text}`,
        reference ? `REFERENCE (not under review):\n${reference}` : '',
        `REPORTED at ${context.file}:${finding.line}: ${finding.description}`,
        'Is this a real defect: would this code misbehave at runtime or in production as described? '
        + 'Answer false if it is style, speculation about unseen callers, or already handled in the code shown. '
        + 'Respond ONLY with JSON: {"real": true|false, "reason": "..."}.',
    ].filter(Boolean).join('\n\n');
}

/** true, false, or undefined when the reply is not a verdict. */
export function parseVerdict(reply: string): boolean | undefined {
    const json = reply.slice(reply.indexOf('{'), reply.lastIndexOf('}') + 1);
    try {
        const value = JSON.parse(json).real;
        return typeof value === 'boolean' ? value : undefined;
    } catch {
        return undefined;
    }
}
