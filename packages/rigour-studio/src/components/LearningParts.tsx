/** A lesson's journey as the learning page draws it: where it was learned, what it stopped, and a person's decision. Learning.tsx loads the data. */
import React from 'react';
import { inlineCode } from './storyData';
import './story.css';

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
