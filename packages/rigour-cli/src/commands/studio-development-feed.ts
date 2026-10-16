/**
 * The "While writing" feed: one plain sentence per moment of the development loop, newest first. A clean edit check and
 * a briefing with nothing to tell are routine (counted on the page, not listed), so the feed keeps what a person reads: briefings, findings, blocks,
 * what an agent was sent back to fix, pushes, and the fixes that followed.
 */
import type { Story } from '@rigour-labs/core';
import type { DevRecord, DevStage } from './studio-development-parts.js';

export type FeedTone = 'ok' | 'warn' | 'info' | 'plain';

export interface FeedItem {
    at: string;
    stage: DevStage | 'fixed';
    branch: string | null;
    agent: string | null;
    session: string | null;
    text: string;
    detail?: string;
    tone: FeedTone;
}

const FEED_LIMIT = 40;

export function buildFeed(records: DevRecord[], stories: Story[]): FeedItem[] {
    const items = [
        ...records.filter(r => !((r.stage === 'edit' || r.stage === 'brief') && r.count === 0)).map(describe),
        ...stories.map(fixed),
    ];
    return items.sort((a, b) => b.at.localeCompare(a.at)).slice(0, FEED_LIMIT);
}

type Said = Pick<FeedItem, 'text' | 'tone' | 'detail'>;

const SAY: Record<DevStage, (r: DevRecord, files: string) => Said> = {
    brief: (r, files) => {
        const told = typeof r.rules === 'number' && r.rules > 0 && r.rules <= r.count
            ? [count(r.rules, 'rule'), r.count - r.rules ? count(r.count - r.rules, 'lesson') : ''].filter(Boolean).join(' and ')
            : count(r.count, 'item');
        return { tone: 'info', text: `Briefed before writing: ${told}${r.files.length ? ` for ${files}` : ''}` };
    },
    edit: (r, files) => ({ tone: 'warn', text: r.held ? `Blocked an edit to ${files}: ${count(r.count, 'problem')}` : `Reported ${count(r.count, 'problem')} on an edit to ${files}` }),
    stop: r => {
        if (r.held) return { tone: 'warn', text: `Agent said done; sent back to fix ${count(r.count, 'problem')}` };
        return r.nothingToReview ? { tone: 'plain', text: 'Agent said done; nothing had changed to review' } : { tone: 'ok', text: 'Agent said done; nothing blocking' };
    },
    push: r => (r.held ? { tone: 'warn', text: `Held a push: ${count(r.count, 'check')} failed` } : { tone: 'ok', text: 'Push checks passed' }),
};

function describe(r: DevRecord): FeedItem {
    const said = SAY[r.stage](r, r.files.length ? list(r.files) : 'a file');
    // What the check said (findings, what held the stop, lessons told) is the detail; a passing stop or push says nothing.
    const detail = r.said.length && said.tone !== 'ok' && said.tone !== 'plain' ? { detail: r.said.join(' · ') } : {};
    return { at: r.at, stage: r.stage, branch: r.branch, agent: r.agent, session: r.session, ...said, ...detail };
}

function fixed(story: Story): FeedItem {
    const minutes = minutesToFix(story);
    return {
        at: story.at, stage: 'fixed', branch: null, agent: null, session: null, tone: 'ok',
        text: `Fixed by the agent: ${story.title}`,
        detail: `${story.file}${minutes === null ? '' : ` · ${minutes < 1 ? 'under a minute' : count(Math.round(minutes), 'minute')} after Rigour reported it`}`,
    };
}

/** From when Rigour reported it to the fix; null for stories kept before the report time was recorded. */
export function minutesToFix(story: Story): number | null {
    if (!story.openedAt) return null;
    const minutes = (Date.parse(story.at) - Date.parse(story.openedAt)) / 60_000;
    return Number.isFinite(minutes) && minutes >= 0 ? minutes : null;
}

function list(files: string[]): string {
    return files.length <= 2 ? files.join(', ') : `${files.slice(0, 2).join(', ')} and ${count(files.length - 2, 'more file')}`;
}

function count(n: number, noun: string): string {
    return `${n} ${noun}${n === 1 ? '' : 's'}`;
}
