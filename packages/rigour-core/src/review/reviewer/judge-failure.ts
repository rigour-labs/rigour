/**
 * Why a judge's run gave no verdict, when its own output says so: a hint the review's reason carries, so a person
 * fixes the cause instead of reading "no valid verdict". Only what the output proves, never a guess.
 */
import { ADAPTERS, type ReviewerName } from './adapters.js';

/** Claude Code's final answer, or its stderr, when the API key it was given is refused ("Invalid API key · Fix external API key"). */
const INVALID_KEY = /^\s*Invalid API key\b/im;

export const INVALID_KEY_HINT = "an ANTHROPIC_API_KEY in this environment overrides the claude CLI's own login; unset it for judges with review.reviewer.judge_env: { claude: { unset: [ANTHROPIC_API_KEY] } }, or fix the key";

/**
 * The hint for a failed run, or undefined. The key is passed to judges by default (people who use an API key with the
 * CLI rely on it), so a stale one is named only when it reached the judge: set here and not unset for it. Only the
 * CLI's own final answer and stderr are read, never the files the judge read on the way (a diff can quote the error).
 */
export function judgeFailureHint(name: ReviewerName, run: { stdout: string; stderr: string }, unset: string[], env: NodeJS.ProcessEnv = process.env, ranCode = false): string | undefined {
    const said = `${ADAPTERS[name].answer(run.stdout).text}\n${run.stderr}`;
    const keyReached = !!env.ANTHROPIC_API_KEY?.trim() && !unset.includes('ANTHROPIC_API_KEY');
    if (name === 'claude' && keyReached && INVALID_KEY.test(said)) return INVALID_KEY_HINT;
    return ranCode ? runCodeLoginHint(name, said, unset, env) : undefined;
}

/** The API-key variables each CLI can log in with, and how to sign it in instead. */
const KEY_LOGINS: Partial<Record<ReviewerName, { keys: string[]; signIn: string }>> = {
    claude: { keys: ['ANTHROPIC_API_KEY'], signIn: '`claude`' },
    codex: { keys: ['OPENAI_API_KEY', 'CODEX_API_KEY'], signIn: '`codex login`' },
};
/** What a CLI says when it has no login it can use. */
const NO_LOGIN = /not (logged|signed) in|please (log|sign) in|\blogin\b|authenticat|unauthori[sz]ed|\b401\b|api key/i;
const RUN_CODE_LOGIN = /run_code removed \S+ from the judge's environment; sign in with `[^`]+`(?: login)? instead/;

/** run_code took the API key a key-only person logs the CLI in with: said, with how to sign in instead. */
function runCodeLoginHint(name: ReviewerName, said: string, unset: string[], env: NodeJS.ProcessEnv): string | undefined {
    const login = KEY_LOGINS[name];
    const removed = login?.keys.find(key => !!env[key]?.trim() && unset.includes(key));
    return login && removed && NO_LOGIN.test(said) ? `run_code removed ${removed} from the judge's environment; sign in with ${login.signIn} instead` : undefined;
}

/** The hint a failed answer's reason carries, so a judge that replaces it does not drop it. */
export function hintIn(error: string): string | undefined {
    return error.includes(INVALID_KEY_HINT) ? INVALID_KEY_HINT : RUN_CODE_LOGIN.exec(error)?.[0];
}

/** A failed answer with its hint, when the run's output carries one; any other answer as it is. */
export function withFailureHint<T extends object>(answer: T | { error: string }, hint: string | undefined): T | { error: string } {
    return hint && 'error' in answer ? { error: `${answer.error} (${hint})` } : answer;
}
