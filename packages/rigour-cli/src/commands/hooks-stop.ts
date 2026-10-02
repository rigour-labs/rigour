/**
 * `rigour hooks stop --tool claude|cursor`: the stop hook.
 *
 * When the agent is about to finish, review its uncommitted change and keep
 * it working on high-severity findings. Each tool's contract:
 *   - Claude Code `Stop`: print {"decision":"block","reason":...}; `stop_hook_active`
 *     marks a stop that a hook already extended.
 *   - Cursor `stop`: print {"followup_message": ...}; `loop_count` counts follow-ups.
 *
 * It never traps an agent: at most STOP_MAX_ATTEMPTS blocks per session, and
 * any failure to review (not a git repository, bad config) lets the agent stop.
 */
import fs from 'fs-extra';
import path from 'path';
import yaml from 'yaml';
import { appendAgentEvent, ConfigSchema, countUsage, recordFixLessons, recordReviewOutcome, STOP_MAX_ATTEMPTS, stopReview, type Config } from '@rigour-labs/core';

export type StopTool = 'claude' | 'cursor';

export interface StopPayload {
    cwd?: string;
    session_id?: string;
    conversation_id?: string;
    stop_hook_active?: boolean;
    loop_count?: number;
    status?: string;
}

export async function hooksStopCommand(tool: StopTool, stdin: string, fallbackCwd: string): Promise<string> {
    const payload = parsePayload(stdin);
    const cwd = payload.cwd || fallbackCwd;
    const session = payload.session_id || payload.conversation_id || 'default';
    if (!shouldReview(tool, payload)) return '';
    const attempt = await nextAttempt(cwd, session);
    if (attempt > STOP_MAX_ATTEMPTS) return '';
    try {
        const decision = await stopReview(cwd, await loadConfig(cwd), attempt);
        appendAgentEvent(cwd, { type: 'stop_review', tool, session, blocked: decision.block, blocking: decision.blocking });
        countUsage('stop_review');
        if (decision.block) countUsage(attempt > 1 ? 'stop_block_repeat' : 'stop_block');
        const capture = recordReviewOutcome(cwd, decision.findings, decision.reviewedFiles);
        await recordFixLessons(cwd, capture.fixes).catch(() => undefined); // learning never blocks the agent
        if (!decision.block) {
            await clearAttempts(cwd, session);
            return '';
        }
        return tool === 'claude'
            ? JSON.stringify({ decision: 'block', reason: decision.message })
            : JSON.stringify({ followup_message: decision.message });
    } catch (error) {
        process.stderr.write(`Rigour stop review skipped: ${error instanceof Error ? error.message : String(error)}\n`);
        return '';
    }
}

/** Review only a finished turn; Cursor's aborted or errored runs are left alone. */
function shouldReview(tool: StopTool, payload: StopPayload): boolean {
    if (tool === 'cursor') return (payload.status ?? 'completed') === 'completed' && (payload.loop_count ?? 0) < STOP_MAX_ATTEMPTS;
    return true;
}

function parsePayload(stdin: string): StopPayload {
    try {
        const parsed = JSON.parse(stdin || '{}');
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

async function loadConfig(cwd: string): Promise<Config> {
    const file = path.join(cwd, 'rigour.yml');
    return ConfigSchema.parse(await fs.pathExists(file) ? yaml.parse(await fs.readFile(file, 'utf8')) : { version: 1 });
}

function stateFile(cwd: string): string {
    return path.join(cwd, '.rigour', 'stop-hook.json');
}

/** Blocks so far this session plus one; counted by Rigour so the cap holds even without the tool's own counter. */
async function nextAttempt(cwd: string, session: string): Promise<number> {
    const state = await fs.readJson(stateFile(cwd)).catch(() => ({})) as Record<string, number>;
    const attempt = (state[session] ?? 0) + 1;
    await fs.outputJson(stateFile(cwd), { [session]: attempt }).catch(() => {});
    return attempt;
}

async function clearAttempts(cwd: string, session: string): Promise<void> {
    const state = await fs.readJson(stateFile(cwd)).catch(() => null) as Record<string, number> | null;
    if (state && session in state) await fs.outputJson(stateFile(cwd), {}).catch(() => {});
}
