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

/** A variable whose name says it holds a secret, or a way to one (a connection string, a webhook). */
const SECRET_NAME = /(KEYS?|TOKEN|SECRETS?|PASSWORD|PASSWD|_PASS|_PWD|CREDENTIALS?|_PAT|_URI|_DSN|WEBHOOK(_URL)?)$|CONNECTION_STRING|^NPM_CONFIG__AUTH/i;
const SECRET_PREFIX = /^(AWS_|GH_)/i;
/** Exact names: a database URL, the tokens package managers and GitHub read, and what reaches a cluster, a daemon or an agent's keys. */
const SECRET_NAMES = new Set(['DATABASE_URL', 'GITHUB_TOKEN', 'NPM_TOKEN', 'NODE_AUTH_TOKEN', 'KUBECONFIG', 'DOCKER_HOST', 'GOOGLE_APPLICATION_CREDENTIALS', 'SSH_AUTH_SOCK']);
/** A URL with a user (and usually a password) in it: `postgres://user:pass@host`. */
const URL_WITH_CREDENTIALS = /^[a-z][a-z0-9+.-]*:\/\/[^/\s@]+@/i;
/** What each judge's own login needs, kept: removing it would sign the judge out. Its answer is redacted like any other (redact.ts). */
const OWN_LOGIN: Record<string, string[]> = { claude: ['CLAUDE_CODE_OAUTH_TOKEN'], codex: ['CODEX_HOME'] };

/**
 * The variables a judge that runs code must not see: whatever a scratch script could read and print. Its own login
 * variable stays (`CLAUDE_CODE_OAUTH_TOKEN`, the Codex home); an API key does not, so a key-only login fails with a hint.
 */
export function secretVariables(judge: string, env: NodeJS.ProcessEnv = process.env): string[] {
    const keep = new Set(['CODEX_HOME', ...(OWN_LOGIN[judge] ?? [])]);
    return Object.keys(env).filter(name => !keep.has(name) && (
        SECRET_NAME.test(name) || SECRET_PREFIX.test(name) || SECRET_NAMES.has(name.toUpperCase())
        || (/_URL$/i.test(name) && URL_WITH_CREDENTIALS.test(env[name] ?? ''))
    )).sort();
}

/**
 * Git, told to ask no one for a credential: no helper (the keychain, a credential store), no terminal prompt, no
 * askpass program. Set for a judge that runs code; the sandbox closes the keychain itself (docs/REVIEWER.md).
 */
export const GIT_WITHOUT_CREDENTIALS: Record<string, string> = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '' };
