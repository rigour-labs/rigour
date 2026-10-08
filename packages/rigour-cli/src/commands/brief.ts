/**
 * The briefing an agent gets before it writes: `rigour brief` for a person or any agent, and `rigour hooks brief` for
 * Claude Code's prompt hook, which briefs once per session from the session's first prompt. Off unless installed with
 * `rigour hooks init --brief`; `brief.enabled: false` in rigour.yml or RIGOUR_BRIEF=0 stops it wherever it is installed.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { briefFile, briefingText, briefTask, fileBriefingText, threadsDir, type Briefing } from '@rigour-labs/core';
import { loadHookConfig } from './hooks-stop.js';

/** Whether briefings are switched off here: the team's rigour.yml or the person's environment. */
async function briefingOff(cwd: string): Promise<{ off: boolean; max: number; lessons?: 'verified' | 'all' | 'off' }> {
    if (/^(0|false|off|no)$/i.test(process.env.RIGOUR_BRIEF?.trim() ?? '')) return { off: true, max: 0 };
    try {
        const config = await loadHookConfig(cwd);
        // The same lessons the team's reviewer checks a change against (gates.deep.review_lessons), before the code exists.
        return { off: config.brief?.enabled === false, max: config.brief?.max_items ?? 10, ...(config.gates.deep?.review_lessons ? { lessons: config.gates.deep.review_lessons } : {}) };
    } catch {
        return { off: false, max: 10 }; // a broken rigour.yml is reported by the checks, not by a briefing
    }
}

/** `rigour brief [goal]`: the briefing for the task in this checkout, as text or JSON. The goal, else the pull request's title and description, else the branch. */
export async function briefCommand(cwd: string, goal: string | undefined, options: { files?: string; json?: boolean }): Promise<number> {
    const { off, max, lessons } = await briefingOff(cwd);
    if (off) {
        if (options.json) console.log(JSON.stringify({ off: true, items: [] }));
        else console.error(chalk.yellow('Briefings are switched off here (brief.enabled: false in rigour.yml, or RIGOUR_BRIEF=0).'));
        return 0;
    }
    const files = options.files?.split(',').map(f => f.trim()).filter(Boolean);
    const briefing = briefTask(cwd, { goal: goal?.trim() || pullRequestGoal(cwd), ...(files?.length ? { files } : {}), limit: max, agent: 'cli', ...(lessons ? { lessons } : {}) });
    if (options.json) console.log(JSON.stringify(briefing, null, 2));
    else console.log(briefingText(briefing) || chalk.dim(`Nothing to brief: no rule or verified lesson of this repository applies to ${briefing.files.length ? briefing.files.join(', ') : 'this task'} yet.`));
    return 0;
}

/**
 * Claude Code's UserPromptSubmit hook: the session's first prompt is the goal; the briefing is added to the agent's
 * context once per session, and never again in it. Prints nothing when switched off or when there is nothing to say.
 */
export async function hooksBriefCommand(stdin: string, fallbackCwd: string): Promise<string> {
    let payload: { cwd?: string; session_id?: string; prompt?: string } = {};
    try {
        payload = JSON.parse(stdin);
    } catch {
        return '';
    }
    const cwd = payload.cwd || fallbackCwd;
    const session = payload.session_id;
    const { off, max, lessons } = await briefingOff(cwd);
    if (off || !session || briefedAlready(cwd, session)) return '';
    const briefing: Briefing = briefTask(cwd, { goal: payload.prompt, limit: max, session, agent: 'claude', ...(lessons ? { lessons } : {}) });
    markBriefed(cwd, session);
    const text = briefingText(briefing);
    return text ? JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } }) : '';
}

/**
 * Claude Code's PreToolUse hook on Edit, Write and MultiEdit: the first time a session edits a file, the team's word on
 * that file (at most three items) is added to the agent's context. Once per file per session; the check for that comes
 * first, so every later edit of the file costs one small file read. Prints nothing when off or when there is nothing.
 */
export async function hooksBriefFileCommand(stdin: string, fallbackCwd: string): Promise<string> {
    let payload: FileHookPayload = {};
    try {
        payload = JSON.parse(stdin);
    } catch {
        return '';
    }
    const text = await fileBriefingContext(payload, fallbackCwd);
    return text ? JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text } }) : '';
}

export interface FileHookPayload { cwd?: string; session_id?: string; tool_name?: string; tool_input?: { file_path?: string } }

/**
 * The team's word on the file a PreToolUse payload is about to edit, the first time the session edits it; '' otherwise.
 * Shared by the edit hook and the DLP pre-tool hook, so a machine with DLP on pays no second process per edit.
 */
export async function fileBriefingContext(payload: FileHookPayload, fallbackCwd: string): Promise<string> {
    const session = payload.session_id;
    const target = payload.tool_input?.file_path;
    if (!session || typeof target !== 'string' || !target) return '';
    const cwd = payload.cwd || fallbackCwd;
    const root = gitOut(cwd, ['rev-parse', '--show-toplevel']);
    if (!root) return '';
    // Once per file per session, checked first and keyed on the path as the agent sent it (one session spells a file one
    // way): every later edit of the file costs this check only.
    const key = `${session}\u0000${path.resolve(cwd, target)}`;
    if (briefedAlready(root, key)) return '';
    markBriefed(root, key); // first, so two quick edits of one file never brief twice
    // Where the file sits, as git says it, never by comparing paths (symlinked folders, Windows drive letters and short
    // names make two spellings of one folder). A file being created is placed through the nearest folder that exists.
    let dir = path.dirname(path.resolve(cwd, target));
    const rest = [path.basename(target)];
    while (!fs.existsSync(dir) && path.dirname(dir) !== dir) {
        rest.unshift(path.basename(dir));
        dir = path.dirname(dir);
    }
    if (gitOut(dir, ['rev-parse', '--show-toplevel']) !== root) return ''; // outside this repository: not the team's file
    const file = `${gitOut(dir, ['rev-parse', '--show-prefix']) ?? ''}${rest.join('/')}`;
    if (!file) return '';
    const { off, lessons } = await briefingOff(root);
    if (off) return '';
    return fileBriefingText(briefFile(root, file, { session, agent: 'claude', ...(lessons ? { lessons } : {}) }));
}

function gitOut(cwd: string, args: string[]): string | undefined {
    const run = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 5000 });
    return run.status === 0 ? run.stdout.trim() : undefined;
}

/** The pull request's title and description as the goal, when gh can read one quickly; undefined otherwise. */
function pullRequestGoal(cwd: string): string | undefined {
    const view = spawnSync('gh', ['pr', 'view', '--json', 'title,body'], { cwd, encoding: 'utf8', timeout: 5000 });
    if (view.status !== 0) return undefined;
    try {
        const pr = JSON.parse(view.stdout);
        return [pr.title, pr.body].filter((t: unknown) => typeof t === 'string' && t.trim()).join('\n') || undefined;
    } catch {
        return undefined;
    }
}

function briefedFile(cwd: string): string | undefined {
    const dir = threadsDir(cwd);
    return dir ? path.join(dir, '..', 'briefed-sessions.json') : undefined;
}

function briefedAlready(cwd: string, session: string): boolean {
    const file = briefedFile(cwd);
    try {
        return !!file && !!JSON.parse(fs.readFileSync(file, 'utf8'))[session];
    } catch {
        return false;
    }
}

function markBriefed(cwd: string, session: string): void {
    const file = briefedFile(cwd);
    if (!file) return;
    try {
        let all: Record<string, string> = {};
        try {
            all = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch {
            // first briefing in this repository
        }
        all[session] = new Date().toISOString();
        // Keep the newest 2,000 entries (sessions, and files within them): a guard against repeating, not a history (the thread is).
        const kept = Object.entries(all).sort((a, b) => (a[1] < b[1] ? 1 : -1)).slice(0, 2000);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(Object.fromEntries(kept)));
    } catch {
        // a session briefed twice is the worst case
    }
}
