/** The Memory page's side: one lesson's journey from where it was learned to stopping a repeat, and how Rigour stores memory. */
import React from 'react';
import { inlineCode, plural, useStudioJson } from './storyData';
import { Card, Empty, Timeline, type TimelineStep } from './ui';
import { LearnsLead, type Journey } from './LearningParts';
import type { Memory } from './MemoryParts';
import './memory.css';

const IN_FORCE = new Set(['validated', 'promoted', 'verified']);
const times = (n: number) => (n === 1 ? 'once' : `${n} times`);

/** The lesson that shows the whole journey best: one that stopped repeats, else the one agents were told most. */
function featuredLesson(lessons: Journey[]): Journey | undefined {
    const score = (l: Journey) => [l.stoppedInDevelopment ?? 0, l.told, IN_FORCE.has(l.state) ? 1 : 0];
    return lessons.filter(l => !l.fromBots).sort((a, b) => {
        const [x, y] = [score(a), score(b)];
        return y[0] - x[0] || y[1] - x[1] || y[2] - x[2];
    })[0];
}

function journeySteps(lesson: Journey): TimelineStep[] {
    const kept = IN_FORCE.has(lesson.state);
    const repeats = lesson.stoppedInDevelopment;
    return [
        { key: 'learned', title: 'Learned', when: lesson.learnedAt ? new Date(lesson.learnedAt).toLocaleDateString() : undefined, tone: 'done', children: <div className="mem-note">{lesson.learnedFrom}</div> },
        { key: 'kept', title: kept ? 'Kept' : 'Waiting for a person', tone: kept ? 'done' : 'todo', children: <div className="mem-note">{kept ? 'In force: agents are given it.' : 'A candidate: agents get it once a person keeps it.'}</div> },
        { key: 'told', title: 'Briefed to agents', tone: lesson.told > 0 ? 'done' : 'todo', children: <div className="mem-note">{lesson.told > 0 ? `Given to an agent ${times(lesson.told)}, in a brief, a recall or a review.` : 'Not given to an agent yet.'}</div> },
        {
            key: 'stopped', title: 'Stopped a repeat', tone: repeats ? 'ok' : 'todo',
            children: <div className="mem-note">{repeats === null ? 'Repeats are counted for lessons from fixes only.' : repeats > 0 ? `The same problem was caught again ${times(repeats)} before a PR (computed by rule and title).` : 'No repeat caught since it was learned.'}</div>,
        },
    ];
}

/** One lesson, end to end: the demo of how a mistake becomes something agents are told. */
export const JourneyCard: React.FC<{ lessons: Journey[] }> = ({ lessons }) => {
    const lesson = featuredLesson(lessons);
    return (
        <Card title="A lesson's journey">
            {lesson
                ? <><div className="mem-lesson-text" style={{ marginTop: 0 }}>{inlineCode(lesson.text)}</div><Timeline steps={journeySteps(lesson)} /></>
                : <Empty>The first lesson shows here once an agent fixes something Rigour reported, a pull request comment is promoted, or you tell an agent to remember something.</Empty>}
            <LearnsLead />
        </Card>
    );
};

interface Info { teamSync?: boolean }
interface Health { storage?: { mode: 'local' | 'team'; connectivity: 'local' | 'online' | 'offline'; queuedChanges: number } }

/** The team database line: off, or connected with what waits to be sent. Read from /api/info and /api/health. */
function teamLine(info: Info | null, health: Health | null, shared: number): string {
    if (!info) return 'Checking…';
    if (!info.teamSync) return 'Off: everything above stays on this machine. rigour team configure connects one.';
    const storage = health?.storage;
    const state = !storage ? 'status not read yet' : storage.connectivity === 'online' ? 'connected' : 'offline: changes wait on this machine';
    const queued = storage?.queuedChanges ? `, ${plural(storage.queuedChanges, 'change')} waiting to send` : '';
    return `On, ${state}${queued}. ${plural(shared, 'lesson')} shared with the team.`;
}

/** Where each kind of memory lives, with live counts, and what is shared with the team and when. */
export const HowMemoryWorks: React.FC<{ lessons: Journey[]; memories: Array<[string, Memory]> }> = ({ lessons, memories }) => {
    const info = useStudioJson<Info>('/api/info').data;
    const health = useStudioJson<Health>('/api/health').data;
    const local = lessons.filter(l => l.origin !== 'pr').length;
    const review = lessons.filter(l => l.origin === 'pr').length;
    const repoFacts = memories.filter(([, m]) => m.source === 'project').length;
    const yourFacts = memories.filter(([, m]) => m.source === 'global').length;
    return (
        <Card title="How Rigour stores memory">
            <div className="mem-store">
                <div className="mem-store-item"><strong>On this machine</strong>{plural(local, 'lesson')} from fixes and memories, in a local database (<code>~/.rigour/rigour.db</code>), plus {plural(yourFacts, 'fact')} you keep for every repository.</div>
                <div className="mem-store-item"><strong>In this repository</strong>{plural(review, 'lesson')} from pull request reviews and {plural(repoFacts, 'fact')}, in its <code>.rigour</code> folder.</div>
                <div className="mem-store-item"><strong>Team database</strong>{teamLine(info, health, lessons.filter(l => l.scope === 'team').length)}</div>
                <div className="mem-store-item"><strong>What gets shared, and when</strong>Teammates' agents get a lesson only once a person shares it. A memory an agent offers the team arrives as a candidate; Share with team on it in Lessons gives it to everyone's agents. Your other lessons stay here unless you send them with <code>rigour team import-local</code>.</div>
            </div>
        </Card>
    );
};
