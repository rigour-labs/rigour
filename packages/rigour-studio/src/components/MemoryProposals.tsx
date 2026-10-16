/**
 * A team memory key's versions side by side: the one the team shares now, and the candidates waiting for it, one card
 * per key. Each proposal has its value, who proposed it and when, and its own Share with team and Drop; the shared one
 * has Take back. Sharing a proposal replaces the shared version; it never drops the other proposals: a person does.
 */
import React from 'react';
import { ago } from './storyData';
import { Chip, Clamp, StateChip } from './ui';
import { LessonCard, RetireButton, type Journey } from './LearningParts';
import { toldBy } from './lessonWords';
import './memory.css';

type Decide = (id: string, state: 'validated' | 'promoted' | 'rejected') => void;
type TakeBack = (id: string) => void;

/** A lesson shown on its own, or one team memory key's shared version and proposals. */
export type LessonItem = { lesson: Journey } | { key: string; shared: Journey[]; proposals: Journey[] };

const teamMemoryKey = (l: Journey) => (l.memory && l.scope === 'team' && (l.state === 'candidate' || l.state === 'promoted') ? l.memory.key : undefined);

/** Whether a key's versions get a card of their own: two proposals or more, or a proposal for a key the team shares. */
const grouped = (versions: Journey[]) => {
    const proposals = versions.filter(l => l.state === 'candidate').length;
    return proposals >= 2 || (proposals >= 1 && proposals < versions.length);
};

/** The lessons in order, with each grouped key's versions where the first of them stands. */
export function groupProposals(lessons: Journey[]): LessonItem[] {
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

/** The other proposals for the same key with this one's value, in words; empty when none. */
function sameValueAs(p: Journey, all: Journey[]): string {
    const same = all.filter(o => o !== p && o.memory?.value === p.memory?.value);
    return same.length ? `same value as ${same.map(toldBy).join(', ')}` : '';
}

const proposedLine = (p: Journey, all: Journey[]) => [`proposed by ${toldBy(p)}`, p.learnedAt ? ago(p.learnedAt) : '', sameValueAs(p, all)].filter(Boolean).join(' · ');

/** What deciding on a proposal does or why it cannot be shared here, on its own line above the buttons. */
function proposalHint(p: Journey, replaces: boolean, quietNoShare?: string): string | undefined {
    if (!p.canDecide) return "An sme or owner decides on a teammate's proposal.";
    if (p.noShare) return p.noShare === quietNoShare ? undefined : p.noShare;
    return replaces ? 'Sharing this replaces the shared version.' : undefined;
}

const Proposal: React.FC<{ proposal: Journey; all: Journey[]; replaces: boolean; onDecide: Decide; quietNoShare?: string }> = ({ proposal: p, all, replaces, onDecide, quietNoShare }) => (
    <div className="mem-version">
        <Clamp text={p.memory?.value ?? p.text} />
        {proposalHint(p, replaces, quietNoShare) && <div className="ui-meta mem-hint">{proposalHint(p, replaces, quietNoShare)}</div>}
        <div className="ui-list-foot">
            <span className="ui-meta">{proposedLine(p, all)}</span>
            {p.canDecide && (
                <div className="ui-actions">
                    {!p.noShare && <button className="st-btn primary" onClick={() => onDecide(p.id, 'promoted')} type="button">Share with team</button>}
                    <button className="st-btn" onClick={() => onDecide(p.id, 'rejected')} type="button">Drop</button>
                </div>
            )}
        </div>
    </div>
);

/** The version teammates' agents get now. */
const SharedNow: React.FC<{ shared: Journey; onTakeBack?: TakeBack }> = ({ shared, onTakeBack }) => (
    <div className="mem-version shared">
        <div className="mem-chips"><Chip tone="ok">Shared now</Chip></div>
        <Clamp text={shared.memory?.value ?? shared.text} />
        <div className="ui-list-foot">
            <span className="ui-meta">{shared.sharedBy ? `Shared by ${shared.sharedBy}` : 'Every teammate\'s agent gets this version'}</span>
            {shared.canRetire && <div className="ui-actions"><RetireButton id={shared.id} onTakeBack={onTakeBack} /></div>}
        </div>
    </div>
);

/** One key's shared version and proposals, each decided on its own. */
const ProposalsCard: React.FC<{ memoryKey: string; shared: Journey[]; proposals: Journey[]; onDecide: Decide; onTakeBack?: TakeBack; quietNoShare?: string }> = ({ memoryKey, shared, proposals, onDecide, onTakeBack, quietNoShare }) => (
    <div className="ui-list-row mem-lesson">
        <div className="mem-row-head">
            <div className="ui-memtext">
                <div className="ui-memkey" title={memoryKey}>{memoryKey}</div>
                <span className="ui-meta">{proposals.length === 1 ? '1 proposal' : `${proposals.length} proposals`} for this team memory key. Sharing one leaves the others as they are: drop those you do not want.</span>
            </div>
            <div className="mem-chips"><StateChip state="waiting" /></div>
        </div>
        <div className="mem-versions">
            {shared.map(s => <SharedNow key={s.id} shared={s} onTakeBack={onTakeBack} />)}
            {proposals.map(p => <Proposal key={p.id} proposal={p} all={proposals} replaces={shared.length > 0} onDecide={onDecide} quietNoShare={quietNoShare} />)}
        </div>
    </div>
);

export type ReviewProps = Omit<React.ComponentProps<typeof LessonCard>, 'lesson' | 'onDecide'>;

/** One item of the Lessons list: a lesson's row, or one row per team memory key with versions to weigh together. */
export const LessonItemView: React.FC<{ item: LessonItem; onDecide: Decide } & ReviewProps> = ({ item, onDecide, ...review }) => ('lesson' in item
    ? <LessonCard lesson={item.lesson} onDecide={onDecide} {...review} />
    : <ProposalsCard memoryKey={item.key} shared={item.shared} proposals={item.proposals} onDecide={onDecide} onTakeBack={review.onTakeBack} quietNoShare={review.quietNoShare} />);

export const itemKey = (item: LessonItem) => ('lesson' in item ? item.lesson.id : `key:${item.key}`);

/** Every lesson as rows, team memory keys with several versions grouped where the first of them stands. */
export const LessonList: React.FC<{ lessons: Journey[]; onDecide: Decide } & ReviewProps> = ({ lessons, onDecide, ...review }) => (
    <div className="ui-list">
        {groupProposals(lessons).map(item => <LessonItemView key={itemKey(item)} item={item} onDecide={onDecide} {...review} />)}
    </div>
);
