/**
 * A team memory key's versions side by side: the one the team shares now, and the candidates waiting for it, one card
 * per key. Each proposal has its value, who proposed it and when, and its own Share with team and Drop; the shared one
 * has Take back. Sharing a proposal replaces the shared version; it never drops the other proposals: a person does.
 */
import React from 'react';
import { inlineCode } from './storyData';
import { Chip } from './ui';
import { LessonCard, RetireButton, type Journey } from './LearningParts';
import './memory.css';

type Decide = (id: string, state: 'validated' | 'promoted' | 'rejected') => void;
type TakeBack = (id: string) => void;

/** A lesson shown on its own, or one team memory key's shared version and proposals. */
type LessonItem = { lesson: Journey } | { key: string; shared: Journey[]; proposals: Journey[] };

const teamMemoryKey = (l: Journey) => (l.memory && l.scope === 'team' && (l.state === 'candidate' || l.state === 'promoted') ? l.memory.key : undefined);

/** Whether a key's versions get a card of their own: two proposals or more, or a proposal for a key the team shares. */
const grouped = (versions: Journey[]) => {
    const proposals = versions.filter(l => l.state === 'candidate').length;
    return proposals >= 2 || (proposals >= 1 && proposals < versions.length);
};

/** The lessons in order, with each grouped key's versions where the first of them stands. */
function groupProposals(lessons: Journey[]): LessonItem[] {
    const byKey = new Map<string, Journey[]>();
    for (const l of lessons) {
        const key = teamMemoryKey(l);
        if (key !== undefined) byKey.set(key, [...(byKey.get(key) ?? []), l]);
    }
    const items: LessonItem[] = [];
    const placed = new Set<string>();
    for (const l of lessons) {
        const key = teamMemoryKey(l);
        const versions = key === undefined ? undefined : byKey.get(key);
        if (!versions || !grouped(versions)) items.push({ lesson: l });
        else if (!placed.has(key!)) {
            placed.add(key!);
            items.push({ key: key!, shared: versions.filter(v => v.state === 'promoted'), proposals: versions.filter(v => v.state === 'candidate') });
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

const Proposal: React.FC<{ proposal: Journey; all: Journey[]; replaces: boolean; onDecide: Decide }> = ({ proposal: p, all, replaces, onDecide }) => (
    <div className="st-need">
        <div className="mem-lesson-text" style={{ marginTop: 0 }}>{inlineCode(p.memory?.value ?? p.text)}</div>
        <div className="st-sub" style={{ marginTop: 4 }}>Proposed by {who(p)}{when(p)}. {sameValueAs(p, all)}</div>
        {p.canDecide
            ? (
                <div className="st-row" style={{ marginTop: 10, gap: 8 }}>
                    {replaces && <span className="st-sub">Sharing this replaces the shared version.</span>}
                    <button className="st-btn primary" onClick={() => onDecide(p.id, 'promoted')} type="button">Share with team</button>
                    <button className="st-btn" onClick={() => onDecide(p.id, 'rejected')} type="button">Drop</button>
                </div>
            )
            : <div className="st-sub" style={{ marginTop: 6 }}>An sme or owner decides on a teammate's proposal.</div>}
    </div>
);

/** The version teammates' agents get now. */
const SharedNow: React.FC<{ shared: Journey; onTakeBack?: TakeBack }> = ({ shared, onTakeBack }) => (
    <div className="st-card">
        <Chip tone="ok">Shared now</Chip>
        <div className="mem-lesson-text">{inlineCode(shared.memory?.value ?? shared.text)}</div>
        {shared.canRetire && <div className="st-row" style={{ marginTop: 10, gap: 8 }}><RetireButton id={shared.id} onTakeBack={onTakeBack} /></div>}
    </div>
);

/** One key's shared version and proposals, each decided on its own. */
const ProposalsCard: React.FC<{ memoryKey: string; shared: Journey[]; proposals: Journey[]; onDecide: Decide; onTakeBack?: TakeBack }> = ({ memoryKey, shared, proposals, onDecide, onTakeBack }) => (
    <div className="st-card mem-lesson">
        <div className="mem-chips">
            <Chip tone="info">told to remember</Chip>
            <Chip tone="warn">{proposals.length === 1 ? '1 proposal' : `${proposals.length} proposals`}</Chip>
        </div>
        <div className="mem-lesson-text">{inlineCode(memoryKey)}</div>
        <div className="st-sub" style={{ marginTop: 4 }}>Team memory candidates for the same key. Sharing one leaves the others as they are: drop those you do not want.</div>
        <div className="st-stack" style={{ marginTop: 12 }}>
            {shared.map(s => <SharedNow key={s.id} shared={s} onTakeBack={onTakeBack} />)}
            {proposals.map(p => <Proposal key={p.id} proposal={p} all={proposals} replaces={shared.length > 0} onDecide={onDecide} />)}
        </div>
    </div>
);

type ReviewProps = Omit<React.ComponentProps<typeof LessonCard>, 'lesson' | 'onDecide'>;

/** The Lessons tab's list: each lesson's card, and one card per team memory key with versions to weigh together. */
export const LessonList: React.FC<{ lessons: Journey[]; onDecide: Decide } & ReviewProps> = ({ lessons, onDecide, ...review }) => (
    <div className="mem-list">
        {groupProposals(lessons).map(item => ('lesson' in item
            ? <LessonCard key={item.lesson.id} lesson={item.lesson} onDecide={onDecide} {...review} />
            : <ProposalsCard key={`key:${item.key}`} memoryKey={item.key} shared={item.shared} proposals={item.proposals} onDecide={onDecide} onTakeBack={review.onTakeBack} />))}
    </div>
);
