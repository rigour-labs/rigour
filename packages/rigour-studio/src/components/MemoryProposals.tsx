/**
 * Team memory candidates that share a key, side by side: one card per key, each proposal with its value, who proposed
 * it and when, and its own Share with team and Drop. Sharing one never drops the others: that stays a person's call.
 */
import React from 'react';
import { inlineCode } from './storyData';
import { Chip } from './ui';
import { LessonCard, type Journey } from './LearningParts';
import './memory.css';

type Decide = (id: string, state: 'validated' | 'promoted' | 'rejected') => void;

/** A lesson shown on its own, or the team memory candidates proposed for one key. */
type LessonItem = { lesson: Journey } | { key: string; proposals: Journey[] };

const proposalKey = (l: Journey) => (l.memory && l.scope === 'team' && l.state === 'candidate' ? l.memory.key : undefined);

/** The lessons in order, with two or more team memory candidates for one key grouped where the first of them stands. */
function groupProposals(lessons: Journey[]): LessonItem[] {
    const byKey = new Map<string, Journey[]>();
    for (const l of lessons) {
        const key = proposalKey(l);
        if (key !== undefined) byKey.set(key, [...(byKey.get(key) ?? []), l]);
    }
    const items: LessonItem[] = [];
    const placed = new Set<string>();
    for (const l of lessons) {
        const key = proposalKey(l);
        const group = key === undefined ? undefined : byKey.get(key);
        if (!group || group.length < 2) items.push({ lesson: l });
        else if (!placed.has(key!)) {
            placed.add(key!);
            items.push({ key: key!, proposals: group });
        }
    }
    return items;
}

const who = (p: Journey) => (p.yours ? 'you' : p.proposedBy ?? 'an agent on this machine');
const when = (p: Journey) => (p.learnedAt ? ` on ${p.learnedAt.slice(0, 10)}` : '');

/** The other proposals for the same key with this one's value, in words; empty when none. */
function sameValueAs(p: Journey, all: Journey[]): string {
    const same = all.filter(o => o !== p && o.memory?.value === p.memory?.value);
    return same.length ? `Same value as ${same.map(who).join(', ')}.` : '';
}

const Proposal: React.FC<{ proposal: Journey; all: Journey[]; onDecide: Decide }> = ({ proposal: p, all, onDecide }) => (
    <div className="st-need">
        <div className="mem-lesson-text" style={{ marginTop: 0 }}>{inlineCode(p.memory?.value ?? p.text)}</div>
        <div className="st-sub" style={{ marginTop: 4 }}>Proposed by {who(p)}{when(p)}. {sameValueAs(p, all)}</div>
        {p.canDecide
            ? (
                <div className="st-row" style={{ marginTop: 10, gap: 8 }}>
                    <button className="st-btn primary" onClick={() => onDecide(p.id, 'promoted')} type="button">Share with team</button>
                    <button className="st-btn" onClick={() => onDecide(p.id, 'rejected')} type="button">Drop</button>
                </div>
            )
            : <div className="st-sub" style={{ marginTop: 6 }}>An sme or owner decides on a teammate's proposal.</div>}
    </div>
);

/** One key's proposals, each decided on its own. */
const ProposalsCard: React.FC<{ memoryKey: string; proposals: Journey[]; onDecide: Decide }> = ({ memoryKey, proposals, onDecide }) => (
    <div className="st-card mem-lesson">
        <div className="mem-chips">
            <Chip tone="info">told to remember</Chip>
            <Chip tone="warn">{proposals.length} proposals</Chip>
        </div>
        <div className="mem-lesson-text">{inlineCode(memoryKey)}</div>
        <div className="st-sub" style={{ marginTop: 4 }}>Team memory candidates for the same key. Sharing one leaves the others as they are: drop those you do not want.</div>
        <div className="st-stack" style={{ marginTop: 12 }}>
            {proposals.map(p => <Proposal key={p.id} proposal={p} all={proposals} onDecide={onDecide} />)}
        </div>
    </div>
);

type ReviewProps = Omit<React.ComponentProps<typeof LessonCard>, 'lesson' | 'onDecide'>;

/** The Lessons tab's list: each lesson's card, and one card per key with several team memory proposals. */
export const LessonList: React.FC<{ lessons: Journey[]; onDecide: Decide } & ReviewProps> = ({ lessons, onDecide, ...review }) => (
    <div className="mem-list">
        {groupProposals(lessons).map(item => ('lesson' in item
            ? <LessonCard key={item.lesson.id} lesson={item.lesson} onDecide={onDecide} {...review} />
            : <ProposalsCard key={`key:${item.key}`} memoryKey={item.key} proposals={item.proposals} onDecide={onDecide} />))}
    </div>
);
