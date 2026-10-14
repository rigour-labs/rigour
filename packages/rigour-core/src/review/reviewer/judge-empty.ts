/**
 * A judge that answered nothing: its CLI reported its usage and the model wrote no token. Claude Code with an expired
 * login, reached through another session's auth, ends that way with a success-shaped result (no error, no text, 0
 * output tokens). That is no verdict, never a pass, and the reason says where to look, not "no valid verdict".
 */
import { ADAPTERS, type ReviewerName, type Spend } from './adapters.js';
import { insideAgentSession } from './judge-env.js';

/** How a person checks each CLI's login; a CLI that reports no tokens (cursor) never reaches here. */
const LOGIN_STATUS: Partial<Record<ReviewerName, string>> = { claude: 'claude auth status', codex: 'codex login status' };

export function emptyAnswer(name: ReviewerName, answer: Spend, env: NodeJS.ProcessEnv = process.env): string | undefined {
    const status = LOGIN_STATUS[name];
    if (!status || !answer.tokens || answer.tokens.output !== 0) return undefined;
    return `the ${ADAPTERS[name].binary} CLI answered nothing (0 output tokens); check its login: \`${status}\`${insideAgentNote(env)}`;
}

/** Appended to a judge's no-answer reason when Rigour runs inside another agent's session. */
export function insideAgentNote(env: NodeJS.ProcessEnv = process.env): string {
    return insideAgentSession(env) ? '; started inside another agent session' : '';
}
