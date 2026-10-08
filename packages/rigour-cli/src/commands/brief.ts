/**
 * The briefing an agent gets before it writes: `rigour brief` for a person or any agent, and `rigour hooks brief` for
 * Claude Code's prompt hook, which briefs once per session from the session's first prompt. Off unless installed with
 * `rigour hooks init --brief`; `brief.enabled: false` in rigour.yml or RIGOUR_BRIEF=0 stops it wherever it is installed.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { briefingText, briefTask, threadsDir, type Briefing } from '@rigour-labs/core';
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
        // Keep the newest 500 sessions: the file is a guard against repeating, not a history (the thread is).
        const kept = Object.entries(all).sort((a, b) => (a[1] < b[1] ? 1 : -1)).slice(0, 500);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(Object.fromEntries(kept)));
    } catch {
        // a session briefed twice is the worst case
    }
}
