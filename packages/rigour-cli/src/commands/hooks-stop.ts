import { execFileSync } from 'child_process';
/**
 * `rigour hooks stop --tool claude|cursor`: the stop hook.
 *
 * When the agent is about to finish, review the branch against where it left main
 * (on main, what this session changed since the commit it started from), so
 * committing hides nothing, and keep it working on findings that must be fixed.
 * A stop with nothing to review is logged as such, never as a clean pass, and a stop after a turn
 * that changed nothing since the last review is let through without repeating it. Each
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
    alreadyReviewed, appendAgentEvent, clearStopAttempts, ConfigSchema, countUsage, nextStopAttempt, recordFixLessons, recordReviewed, recordReviewOutcome, workFingerprint,
    sessionBaseline, STOP_MAX_ATTEMPTS, stopReview, teamMessage, untaught, recordTaught, captureHumanEdits, type Config,
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
    // A turn that changed nothing since the last review has nothing new to say: no repeated list.
    let config: Config | undefined;
    try {
        config = await loadHookConfig(cwd);
    } catch {
        // a broken rigour.yml is reported by the review below
    }
    const fingerprint = workFingerprint(cwd, ['.rigour', config?.output?.report_path ?? 'rigour-report.json', 'rigour-fix-packet.json']);
    if (alreadyReviewed(cwd, session, fingerprint)) return '';
    const attempt = nextStopAttempt(cwd, session);
    if (attempt > STOP_MAX_ATTEMPTS) return '';
    try {
        const decision = await stopReview(cwd, config ?? await loadHookConfig(cwd), attempt, sessionBaseline(cwd, session));
        const nothing = decision.reviewedFiles.length === 0;
        appendAgentEvent(cwd, { type: 'stop_review', tool, session, blocked: decision.block, blocking: decision.blocking, against: decision.against, ...(nothing ? { nothing_to_review: true } : {}) });
        if (nothing) process.stderr.write(`Rigour stop review: nothing to review against ${decision.against}.\n`);
        countUsage('stop_review');
        if (decision.block) countUsage(attempt > 1 ? 'stop_block_repeat' : 'stop_block');
        recordReviewed(cwd, session, fingerprint);
        const capture = recordReviewOutcome(cwd, decision.findings, decision.reviewedFiles, 'stop');
        await recordFixLessons(cwd, capture.fixes).catch(() => undefined); // learning never blocks the agent
        try {
            captureHumanEdits(cwd, gitEmail(cwd)); // a person's change to what the agent wrote is a lesson
        } catch {
            // learning never blocks the agent
        }
        // What the team learned that applies here, each lesson or rule asked once per session: a senior's question, not a loop.
        const fresh = untaught(cwd, session, decision.guidance.map(g => g.key));
        const guidance = decision.guidance.filter(g => fresh.includes(g.key));
        recordTaught(cwd, session, fresh);
        if (!decision.block) {
            clearStopAttempts(cwd, session);
            return guidance.length ? blockWith(tool, teamMessage(guidance)) : '';
        }
        return blockWith(tool, guidance.length ? `${decision.message}\n\n${teamMessage(guidance)}` : decision.message);
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

/** The repository's rigour.yml, or the defaults; shared by the stop and push hooks. */
export async function loadHookConfig(cwd: string): Promise<Config> {
    const file = path.join(cwd, 'rigour.yml');
    return ConfigSchema.parse(await fs.pathExists(file) ? yaml.parse(await fs.readFile(file, 'utf8')) : {});
}

/** Who is at the keyboard, by their git email, for the record of a correction. */
function gitEmail(cwd: string): string {
    try {
        return execFileSync('git', ['config', 'user.email'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || 'a person';
    } catch {
        return 'a person';
    }
}
