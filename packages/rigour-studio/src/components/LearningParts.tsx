/** A lesson's journey as the learning page draws it: where it was learned, what it stopped, and a person's decision. Learning.tsx loads the data. */
import React from 'react';
import { inlineCode } from './storyData';
import './story.css';

/** How a lesson reaches an agent, as it actually does: on request, or by itself in Claude Code with the brief hooks. */
export const LearnsLead: React.FC = () => (
    <p className="st-lead">
        Every mistake fixed in development or caught at a PR becomes a lesson. An agent gets the lessons when it asks for a brief
        (the <code>rigour_brief</code> tool, or <code>rigour brief</code>). In Claude Code, <code>rigour hooks init --brief</code> hands
        them over by itself: at a session's first prompt and on each file's first edit.
    </p>
);

export interface Journey {
    id: string;
    text: string;
    origin: 'development' | 'pr' | 'memory';
    learnedFrom: string;
    state: string;
    scope: string;
    told: number;
    stoppedInDevelopment: number | null;
    reachedPr: number | null;
    canDecide: boolean;
    /** Taken back by what happened after later merges; a person may promote it again. */
    takenBack?: { detail: string; prs: number[]; at: string };
    /** A later fix changed the point's own lines: evidence for a person to promote or dismiss. */
    suggested?: { detail: string; pr: number; at: string };
    /** Back to a candidate when outcomes stopped promoting, with the evidence that had promoted it. */
    reclassified?: { detail: string; evidence: string[] };
}

/** null means unknown on this machine; a lesson that is not about a kind of defect has no repeats to count. */
const times = (n: number | null, counted = true) => (!counted ? '—' : n === null ? 'not recorded here' : n === 1 ? '1 time' : `${n} times`);

export const LessonCard: React.FC<{ lesson: Journey; onDecide: (id: string, state: 'validated' | 'promoted' | 'rejected') => void; onDecideReview?: (id: string, decision: 'accepted' | 'rejected' | 'dismissed') => void }> = ({ lesson, onDecide, onDecideReview }) => (
    <div className="st-card">
        <div className="st-row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div style={{ fontSize: 17, lineHeight: 1.5, flex: 1 }}>{inlineCode(lesson.text)}</div>
            <span className="st-chip">{lesson.scope === 'team' ? 'shared with team' : lesson.scope}</span>
        </div>
        <div className="st-journey">
            <div style={{ background: 'var(--bg-surface)' }}><div className="st-sub">Learned</div><div style={{ fontSize: 14, marginTop: 4 }}>{lesson.learnedFrom}</div></div>
            <div><div className="st-sub">Agents told</div><div style={{ fontSize: 14, marginTop: 4 }}>{times(lesson.told)}</div></div>
            <div><div className="st-sub">Stopped in development</div><div style={{ fontSize: 14, marginTop: 4 }}>{times(lesson.stoppedInDevelopment, lesson.origin === 'development')}</div></div>
            <div><div className="st-sub">Reached a PR again</div><div style={{ fontSize: 14, marginTop: 4 }}>{times(lesson.reachedPr, lesson.origin === 'development')}</div></div>
        </div>
        {lesson.takenBack && (
            <div style={{ marginTop: 14 }}>
                <div><span className="st-chip warn">taken back</span> <span className="st-sub">{lesson.takenBack.detail}</span></div>
                <div className="st-row" style={{ marginTop: 10 }}>
                    <span className="st-sub">Later pull requests a review found repeating it merged and stayed fine. Keep telling agents anyway?</span>
                    <button className="st-btn primary" onClick={() => onDecideReview?.(lesson.id, 'accepted')} type="button">Promote again</button>
                    <button className="st-btn" onClick={() => onDecideReview?.(lesson.id, 'rejected')} type="button">Drop</button>
                </div>
            </div>
        )}
        {lesson.reclassified && (
            <div style={{ marginTop: 14 }}>
                <div><span className="st-chip warn">back to candidate</span> <span className="st-sub">{lesson.reclassified.detail}</span></div>
                {lesson.reclassified.evidence.map(line => <div key={line} className="st-sub" style={{ marginTop: 4 }}>{line}</div>)}
                <div className="st-row" style={{ marginTop: 10 }}>
                    <span className="st-sub">A later fix on its lines used to make this a lesson by itself; now a person decides. Keep telling agents?</span>
                    <button className="st-btn primary" onClick={() => onDecideReview?.(lesson.id, 'accepted')} type="button">Promote</button>
                    <button className="st-btn" onClick={() => onDecideReview?.(lesson.id, 'dismissed')} type="button">Dismiss</button>
                </div>
            </div>
        )}
        {lesson.suggested && (
            <div style={{ marginTop: 14 }}>
                <div><span className="st-chip">a later fix changed these lines</span> <span className="st-sub">{lesson.suggested.detail}</span></div>
                <div className="st-row" style={{ marginTop: 10 }}>
                    <span className="st-sub">The pull request (#{lesson.suggested.pr}) left this point alone, and a later fix changed its lines. If that fix is about this point, the lesson was right.</span>
                    <button className="st-btn primary" onClick={() => onDecideReview?.(lesson.id, 'accepted')} type="button">Promote</button>
                    <button className="st-btn" onClick={() => onDecideReview?.(lesson.id, 'dismissed')} type="button">Dismiss</button>
                </div>
            </div>
        )}
        {lesson.canDecide && !lesson.takenBack && !lesson.suggested && !lesson.reclassified && (
            <div className="st-row" style={{ marginTop: 14 }}>
                <span className="st-sub">{lesson.scope === 'team' ? 'Shared by a teammate. Give it to everyone\'s agents?' : 'Seen once. Keep it so your agents get told?'}</span>
                <button className="st-btn primary" onClick={() => onDecide(lesson.id, lesson.scope === 'team' ? 'promoted' : 'validated')} type="button">{lesson.scope === 'team' ? 'Share with team' : 'Keep'}</button>
                <button className="st-btn" onClick={() => onDecide(lesson.id, 'rejected')} type="button">Drop</button>
            </div>
        )}
    </div>
);

interface Share { count: number; of: number; rate: number | null }
/** The outcome numbers (core outcomes/metrics.ts), as Studio shows them. */
export interface OutcomeNumbers {
    records: { merged: number; settled: number; unsettled: number };
    settled: { ciRegressed: Share; ciUnknown: number; reverted: Share; fixedLater: Share; reviewed: { prs: number; fixedLater: Share }; notReviewed: { prs: number; fixedLater: Share } };
    lessons: { awaitingDecision: number; promotedFromEvidence: number; dismissed: number; takenBack: number };
}

/** A count, with a percentage only where there are enough records for one. */
const shareText = (s: Share) => `${s.count} of ${s.of}${s.rate === null ? '' : ` (${Math.round(s.rate * 100)}%)`}`;

/** What happened after merges: counts only. Reviewed and not reviewed side by side, never compared. */
export const OutcomeCard: React.FC<{ numbers: OutcomeNumbers }> = ({ numbers: m }) => (
    <section className="st-card" style={{ margin: '0 0 24px' }}>
        <strong>After the merge</strong>
        <div className="st-sub" style={{ marginTop: 4 }}>{m.records.merged} merged pull requests read on this machine; {m.records.settled} settled, {m.records.unsettled} with the window still open.</div>
        <div className="st-journey" style={{ marginTop: 10 }}>
            <div><div className="st-sub">CI regressed on the merge</div><div style={{ fontSize: 14, marginTop: 4 }}>{shareText(m.settled.ciRegressed)}{m.settled.ciUnknown ? `, ${m.settled.ciUnknown} with no CI to read` : ''}</div></div>
            <div><div className="st-sub">Reverted</div><div style={{ fontSize: 14, marginTop: 4 }}>{shareText(m.settled.reverted)}</div></div>
            <div><div className="st-sub">Reviewed by Rigour</div><div style={{ fontSize: 14, marginTop: 4 }}>{m.settled.reviewed.prs} pull requests, {m.settled.reviewed.fixedLater.count} fixed later</div></div>
            <div><div className="st-sub">Not reviewed</div><div style={{ fontSize: 14, marginTop: 4 }}>{m.settled.notReviewed.prs} pull requests, {m.settled.notReviewed.fixedLater.count} fixed later</div></div>
        </div>
        <div className="st-sub" style={{ marginTop: 10, lineHeight: 1.6 }}>
            Lessons: {m.lessons.awaitingDecision} waiting on you, {m.lessons.promotedFromEvidence} promoted from evidence, {m.lessons.dismissed} dismissed, {m.lessons.takenBack} taken back.
            {' '}Teams choose which pull requests get reviewed, so the two groups differ: this is not a comparison.
        </div>
    </section>
);
