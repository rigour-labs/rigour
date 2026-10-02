/**
 * Studio's "This week": what needs someone, what Rigour stopped, and how often it was overruled.
 * Every number is counted from what Rigour recorded (stories, open findings, dismissals, events);
 * nothing is estimated. `recordingSince` says how far back that record goes.
 */
import fs from 'fs';
import path from 'path';
import { listOpenFindings, readAgentEvents, readStories, type AgentEvent, type CatchStage, type Story } from '@rigour-labs/core';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_STORIES = 50;
const DEVELOPMENT: CatchStage[] = ['edit', 'review', 'stop'];

export interface Dismissal { key: string; reason: string; at: string; check?: string }

export interface WeekInputs {
    now: Date;
    stories: Story[];
    open: Array<{ file: string; rule: string; title?: string; openedAt: string; stage?: CatchStage }>;
    dismissals: Dismissal[];
    events: AgentEvent[];
}

export interface StudioWeek {
    recordingSince: string | null;
    from: string;
    to: string;
    needs: Array<{ file: string; rule: string; title: string; openedAt: string; stage?: CatchStage }>;
    stories: Story[];
    stopped: { total: number; byStage: Record<CatchStage, number> };
    /** Times an agent tried to finish with a problem Rigour proved, and then fixed it. */
    agentSaidDone: number;
    /** Findings branch reviews reported this week; null when no branch review was ever recorded here. */
    prCatches: number | null;
    /** Problems raised this week (fixed, dismissed or still open) and how many a person overruled. */
    raised: number;
    overruled: number;
}

export function buildWeek(input: WeekInputs): StudioWeek {
    const from = new Date(input.now.getTime() - WEEK_MS);
    const inWeek = (at: string) => Date.parse(at) >= from.getTime() && Date.parse(at) <= input.now.getTime();
    const stories = input.stories.filter(s => DEVELOPMENT.includes(s.stage) && inWeek(s.at));
    const byStage = { edit: 0, review: 0, stop: 0, pr: 0 } as Record<CatchStage, number>;
    for (const story of stories) byStage[story.stage]++;
    const overruled = input.dismissals.filter(d => inWeek(d.at)).length;
    const openedThisWeek = input.open.filter(o => inWeek(o.openedAt)).length;
    const prEvents = input.events.filter(e => e.type === 'pr_catches');
    return {
        recordingSince: earliest([...input.stories.map(s => s.at), ...input.events.flatMap(e => (e.timestamp ? [e.timestamp] : []))]),
        from: from.toISOString(),
        to: input.now.toISOString(),
        needs: input.open.map(o => ({ ...o, title: o.title ?? o.rule })),
        stories: [...stories].reverse().slice(0, MAX_STORIES),
        stopped: { total: stories.length, byStage },
        agentSaidDone: byStage.stop,
        prCatches: prEvents.length === 0 ? null : prEvents.filter(e => e.timestamp && inWeek(e.timestamp)).reduce((n, e) => n + (e.findings?.length ?? 0), 0),
        raised: stories.length + overruled + openedThisWeek,
        overruled,
    };
}

export function loadWeek(cwd: string, now = new Date()): StudioWeek {
    return buildWeek({ now, stories: readStories(cwd), open: listOpenFindings(cwd), dismissals: readDismissals(cwd), events: readAgentEvents(cwd) });
}

function readDismissals(cwd: string): Dismissal[] {
    try {
        const parsed = JSON.parse(fs.readFileSync(path.join(cwd, '.rigour', 'dismissed.json'), 'utf8'));
        return Array.isArray(parsed?.entries) ? parsed.entries.filter((e: Dismissal) => typeof e?.at === 'string') : [];
    } catch {
        return [];
    }
}

function earliest(times: string[]): string | null {
    const valid = times.filter(t => Number.isFinite(Date.parse(t))).sort();
    return valid[0] ?? null;
}
