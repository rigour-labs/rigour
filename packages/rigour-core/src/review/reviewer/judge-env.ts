/**
 * What a judge's CLI must not see. A judge runs with the person's environment, because that is how
 * an agent CLI finds its login or its API key; but a key meant for something else must not reach
 * it. RIGOUR_API_KEY (Rigour's own model-review key) never does, and a team names any other
 * variable per judge in review.reviewer.judge_env (e.g. OPENAI_API_KEY holding a gateway key).
 */
const NEVER_TO_JUDGES = ['RIGOUR_API_KEY'];

/**
 * What a host agent session sets for the commands it runs that makes a judge part of that session rather than a run
 * of its own. Measured with Claude Code 2.1.285 started from a Claude Desktop session: CLAUDE_CODE_ENTRYPOINT
 * (claude-desktop) alone gives the judge the desktop app's tools (Artifact, SendUserFile, plugin and skill
 * suggestions), its agent and skills, and authenticates it through the desktop host instead of the judge's own login or
 * key, so an expired login answers nothing instead of failing. Nothing else is stripped: the rest of a session's
 * variables changed neither, and ANTHROPIC_BASE_URL can be a person's own proxy.
 */
const HOST_SESSION = ['CLAUDE_CODE_ENTRYPOINT'];

/** Variables that say this process runs inside another agent's session (any vendor's CLI may be started from one). */
const AGENT_SESSION_MARKERS = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'];

export function judgeUnset(name: string, judgeEnv: Record<string, { unset: string[] }>): string[] {
    return [...new Set([...NEVER_TO_JUDGES, ...HOST_SESSION, ...(judgeEnv[name]?.unset ?? [])])];
}

/** Whether Rigour runs inside another agent's session: said with a judge that gives no answer, as a likely cause. */
export function insideAgentSession(env: NodeJS.ProcessEnv = process.env): boolean {
    return AGENT_SESSION_MARKERS.some(name => !!env[name]?.trim());
}

/** A variable whose name says it holds a secret. */
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|_PAT)$/i;
const SECRET_PREFIX = /^(AWS_|GH_)/i;
const SECRET_NAMES = new Set(['DATABASE_URL', 'GITHUB_TOKEN', 'NPM_TOKEN', 'NODE_AUTH_TOKEN']);
/** A URL with a user (and usually a password) in it: `postgres://user:pass@host`. */
const URL_WITH_CREDENTIALS = /^[a-z][a-z0-9+.-]*:\/\/[^/\s@]+@/i;
/** What a judge's own login needs, kept: the Codex home its login lives in (judge-isolation.ts sets it under a profile). */
const LOGIN = new Set(['CODEX_HOME']);

/**
 * The variables a judge that runs code must not see: whatever a scratch script could read and print. Its login
 * stays with the CLI's own stored login (`codex login`, `claude` signed in), never a key in the environment.
 */
export function secretVariables(env: NodeJS.ProcessEnv = process.env): string[] {
    return Object.keys(env).filter(name => !LOGIN.has(name) && (
        SECRET_NAME.test(name) || SECRET_PREFIX.test(name) || SECRET_NAMES.has(name.toUpperCase())
        || (/_URL$/i.test(name) && URL_WITH_CREDENTIALS.test(env[name] ?? ''))
    )).sort();
}
