/**
 * `rigour hooks stop --tool claude|cursor`: the stop hook.
 *
 * When the agent is about to finish, review the branch against where it left main
 * (on main, what this session changed since the commit it started from), so
 * committing hides nothing, and keep it working on findings that must be fixed.
 * A stop with nothing to review is logged as such, never as a clean pass. Each
 * tool's contract:
 *   - Claude Code `Stop`: print {"decision":"block","reason":...}; `stop_hook_active`
 *     marks a stop that a hook already extended.
 *   - Cursor `stop`: print {"followup_message": ...}; `loop_count` counts follow-ups.
 *
 * It never traps an agent: at most STOP_MAX_ATTEMPTS blocks per session, counted
 * outside the workspace (session-state.ts) so the agent cannot reset it. A review
 * that fails (bad config, git error) blocks once with the reason, then lets the
 * agent stop: a broken setup is surfaced, not silently skipped.
 */
import fs from 'fs-extra';
import path from 'path';
import yaml from 'yaml';
import {
    appendAgentEvent, clearStopAttempts, ConfigSchema, countUsage, nextStopAttempt, recordFixLessons, recordReviewOutcome,
    sessionBaseline, STOP_MAX_ATTEMPTS, stopReview, type Config,
} from '@rigour-labs/core';

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
    const attempt = nextStopAttempt(cwd, session);
    if (attempt > STOP_MAX_ATTEMPTS) return '';
    try {
        const decision = await stopReview(cwd, await loadConfig(cwd), attempt, sessionBaseline(cwd, session));
        const nothing = decision.reviewedFiles.length === 0;
        appendAgentEvent(cwd, { type: 'stop_review', tool, session, blocked: decision.block, blocking: decision.blocking, against: decision.against, ...(nothing ? { nothing_to_review: true } : {}) });
        if (nothing) process.stderr.write(`Rigour stop review: nothing to review against ${decision.against}.\n`);
        countUsage('stop_review');
        if (decision.block) countUsage(attempt > 1 ? 'stop_block_repeat' : 'stop_block');
        const capture = recordReviewOutcome(cwd, decision.findings, decision.reviewedFiles, 'stop');
        await recordFixLessons(cwd, capture.fixes).catch(() => undefined); // learning never blocks the agent
        if (!decision.block) {
            clearStopAttempts(cwd, session);
            return '';
        }
        return blockWith(tool, decision.message);
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        process.stderr.write(`Rigour stop review failed: ${reason}\n`);
        return attempt === 1
            ? blockWith(tool, `Rigour could not review this change: ${reason}\nFix the cause (often rigour.yml) and finish again; the next stop is not blocked.`)
            : '';
    }
}

function blockWith(tool: StopTool, message: string): string {
    return tool === 'claude' ? JSON.stringify({ decision: 'block', reason: message }) : JSON.stringify({ followup_message: message });
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
