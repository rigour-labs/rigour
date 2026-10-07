/**
 * What a judge's CLI must not see. A judge runs with the person's environment, because that is how
 * an agent CLI finds its login or its API key; but a key meant for something else must not reach
 * it. RIGOUR_API_KEY (Rigour's own model-review key) never does, and a team names any other
 * variable per judge in review.reviewer.judge_env (e.g. OPENAI_API_KEY holding a gateway key).
 */
const NEVER_TO_JUDGES = ['RIGOUR_API_KEY'];

export function judgeUnset(name: string, judgeEnv: Record<string, { unset: string[] }>): string[] {
    return [...new Set([...NEVER_TO_JUDGES, ...(judgeEnv[name]?.unset ?? [])])];
}
