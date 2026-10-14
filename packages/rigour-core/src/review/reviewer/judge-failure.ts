/**
 * Why a judge's run gave no verdict, when its own output says so: a hint the review's reason carries, so a person
 * fixes the cause instead of reading "no valid verdict". Only what the output proves, never a guess.
 */
import type { ReviewerName } from './adapters.js';

/** Claude Code's answer when the API key it was given is refused ("Invalid API key · Fix external API key"). */
const INVALID_KEY = /Invalid API key/i;

export const INVALID_KEY_HINT = "an ANTHROPIC_API_KEY in this environment overrides the claude CLI's own login; unset it for judges with review.reviewer.judge_env: { claude: { unset: [ANTHROPIC_API_KEY] } }, or fix the key";

/**
 * The hint for a failed run, or undefined. The key is passed to judges by default (people who use an API key with the
 * CLI rely on it), so a stale one is named only when it reached the judge: set here and not unset for it.
 */
export function judgeFailureHint(name: ReviewerName, run: { stdout: string; stderr: string }, unset: string[], env: NodeJS.ProcessEnv = process.env): string | undefined {
    const keyReached = !!env.ANTHROPIC_API_KEY?.trim() && !unset.includes('ANTHROPIC_API_KEY');
    if (name === 'claude' && keyReached && INVALID_KEY.test(`${run.stdout}\n${run.stderr}`)) return INVALID_KEY_HINT;
    return undefined;
}

/** A failed answer with its hint, when the run's output carries one; any other answer as it is. */
export function withFailureHint<T extends object>(answer: T | { error: string }, hint: string | undefined): T | { error: string } {
    return hint && 'error' in answer ? { error: `${answer.error} (${hint})` } : answer;
}
