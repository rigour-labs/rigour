/** A lesson's journey as the learning page draws it: where it was learned, what it stopped, and a person's decision. Learning.tsx loads the data. */
import React from 'react';
import { inlineCode } from './storyData';
import { Chip, type Tone } from './ui';
import './story.css';
import './memory.css';

/** How a lesson reaches an agent, as it actually does: on request, or by itself in Claude Code with the brief hooks. */
export const LearnsLead: React.FC = () => (
    <p className="mem-note">
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
    /** When it was learned (ISO); absent from older data. */
    learnedAt?: string;
    state: string;
    scope: string;
    told: number;
    stoppedInDevelopment: number | null;
    reachedPr: number | null;
    canDecide: boolean;
    /** A team memory's key and value, waiting or shared: one key's are shown together (MemoryProposals.tsx). */
    memory?: { key: string; value: string };
    /** Who proposed a team candidate (an actor id), and whether it is this person. */
    proposedBy?: string;
    yours?: true;
    /** A shared team memory this person may take back. */
    canRetire?: true;
    /** Why this person cannot share a team candidate: Share is not offered, Drop still is for their own. */
    noShare?: string;
    /** Who shared a shared team lesson, as the team database recorded it where it did. */
    sharedBy?: string;
    /** Taken back by what happened after later merges; a person may promote it again. */
    takenBack?: { detail: string; prs: number[]; at: string };
    /** A later fix changed the point's own lines: evidence for a person to promote or dismiss. */
    suggested?: { detail: string; pr: number; at: string };
    /** Back to a candidate when outcomes stopped promoting, with the evidence that had promoted it. */
    reclassified?: { detail: string; evidence: string[] };
    /** A corrected wording for a lesson a person decided; it changes only when they take it. */
    suggestedText?: { text: string; why: string };
    /** How far a review lesson reaches: its file, its folder, or every change (a team standard). */
    reach?: { scope: 'file' | 'folder' | 'repo'; hasFile: boolean };
    /** A candidate only review bots raised, with nothing waiting on a person: hidden until a person asks to see bot points. */
    fromBots?: true;
    /** A person's last decision on this review lesson (promoted, rejected, not a rule) can be taken back to a candidate. */
    canTakeBack?: true;
    /** Teammates' decisions on this lesson, by display name; and a later team decision that settled it against yours. */
    team?: {
        decisions: Array<{ kind: string; name: string; at: string; detail?: string }>;
        overruled?: { yours: string; team: { kind: string; name: string; at: string }; yoursOnly?: string };
    };
    /** Other lessons agents are given with the same words but different evidence. */
    conflicts?: string[];
    /** A review lesson's trail: who made each point at which pull request, and who decided and why. */
    evidence?: EvidenceItem[];
}

export interface EvidenceItem { kind: string; pr: number; author: string; source?: 'person' | 'bot'; detail?: string; at?: string; team?: true }

const DAY_MS = 24 * 60 * 60 * 1000;
/** A lesson agents have not been given for this long since it was learned is called unused. */
const UNUSED_DAYS = 60;
const SETTLED_AGAINST = new Set(['rejected', 'dropped', 'superseded']);

/** Whether a lesson is working: one that contradicts another, or one never given to an agent in 60 days. */
function lessonHealth(lesson: Journey): { tone: Tone; text: string; why: string } | null {
    if (lesson.conflicts?.length) {
        const more = lesson.conflicts.length > 1 ? ` and ${lesson.conflicts.length - 1} more` : '';
        return { tone: 'bad', text: `contradicts ${lesson.conflicts[0]}${more}`, why: 'Same words, different evidence: agents are given both.' };
    }
    const age = lesson.learnedAt ? Date.now() - Date.parse(lesson.learnedAt) : NaN;
    if (lesson.told === 0 && age > UNUSED_DAYS * DAY_MS && !SETTLED_AGAINST.has(lesson.state)) {
        return { tone: 'warn', text: `unused ${UNUSED_DAYS} days`, why: `Learned over ${UNUSED_DAYS} days ago and never given to an agent on this machine.` };
    }
    return null;
}

const ORIGIN_WORDS: Record<Journey['origin'], string> = { development: 'from a fix', pr: 'from a pull request', memory: 'told to remember' };
const STATE_CHIP: Record<string, [string, Tone]> = {
    candidate: ['candidate', 'warn'], validated: ['in force', 'ok'], promoted: ['in force', 'ok'], verified: ['in force', 'ok'],
    rejected: ['decided against', 'plain'], dropped: ['not a rule', 'plain'],
};

/** Where a lesson came from, where it stands, and whether it is working, as chips. */
const LessonChips: React.FC<{ lesson: Journey }> = ({ lesson }) => {
    const [state, tone] = STATE_CHIP[lesson.state] ?? [lesson.state, 'plain'];
    const health = lessonHealth(lesson);
    return (
        <div className="mem-chips">
            <Chip tone="info">{ORIGIN_WORDS[lesson.origin]}</Chip>
            <Chip tone={tone}>{state}</Chip>
            <Chip>{lesson.scope === 'team' ? 'shared with team' : lesson.scope}</Chip>
            {health && <span title={health.why}><Chip tone={health.tone}>{health.text}</Chip></span>}
        </div>
    );
};

/** What a decided review lesson is, beside its Take back. */
const TAKE_BACK_SAYS: Record<string, string> = { verified: 'Promoted: agents are told it.', rejected: 'Dropped: agents are told the team decided against it.', dropped: 'Not a rule: never told to agents.' };

/** A teammate's decision, in words. */
const TEAM_VERB: Record<string, string> = { accepted: 'accepted', rejected: 'rejected', dismissed: 'dismissed', scoped: 'set how far it reaches', reworded: 'reworded', compiled: 'decided its compiled check', 'not-a-rule': 'judged not a rule', 'took-back': 'took back the decision on' };
const day = (iso: string) => iso.slice(0, 10);

/** The team's decisions on a lesson, and, when a later one settled it against yours, both. */
const TeamDecisions: React.FC<{ team: NonNullable<Journey['team']> }> = ({ team }) => (
    <div style={{ marginTop: 14 }}>
        {team.overruled && (
            <div>
                <span className="ui-chip warn">the team decided</span>{' '}
                <span className="st-sub">
                    You {TEAM_VERB[team.overruled.yours] ?? team.overruled.yours} it{team.overruled.yoursOnly ? ` (yours only: ${team.overruled.yoursOnly})` : ''}; {team.overruled.team.name} {TEAM_VERB[team.overruled.team.kind] ?? team.overruled.team.kind} it on {day(team.overruled.team.at)}, and the team's decision is what agents are told.
                </span>
            </div>
        )}
        {team.decisions.map(d => (
            <div key={`${d.at}-${d.kind}-${d.name}`} className="st-sub" style={{ marginTop: 4 }}>
                {d.name} (team) {TEAM_VERB[d.kind] ?? d.kind} it on {day(d.at)}{d.detail ? `: ${d.detail}` : ''}
            </div>
        ))}
    </div>
);

/** Candidates only review bots raised are hidden by default and counted; a person can show them. */
export const BotPointsToggle: React.FC<{ count: number; shown: boolean; onToggle: () => void }> = ({ count, shown, onToggle }) => (
    <div className="st-row" style={{ marginTop: 12, gap: 8 }}>
        <span className="st-sub">{count} candidate{count === 1 ? '' : 's'} from review bots{shown ? '' : ', hidden'}.</span>
        <button type="button" className="st-btn" onClick={onToggle}>{shown ? 'Hide bot points' : 'Show bot points'}</button>
    </div>
);

/** null means unknown on this machine; a lesson that is not about a kind of defect has no repeats to count. */
const times = (n: number | null, counted = true) => (!counted ? '—' : n === null ? 'not recorded here' : n === 1 ? '1 time' : `${n} times`);

/** Take back a shared team memory: agents stop getting it. */
export const RetireButton: React.FC<{ id: string; onTakeBack?: (id: string) => void }> = ({ id, onTakeBack }) => (
    <button className="st-btn" onClick={() => onTakeBack?.(id)} type="button" title="Superseded when a newer shared version of its key exists, dropped otherwise">Take back</button>
);

export const LessonCard: React.FC<{ lesson: Journey; onDecide: (id: string, state: 'validated' | 'promoted' | 'rejected') => void; onDecideReview?: (id: string, decision: 'accepted' | 'rejected' | 'dismissed' | 'not-a-rule' | 'took-back' | 'reworded') => void; onScope?: (id: string, to: 'file' | 'folder' | 'repo') => void; onTakeBack?: (id: string) => void }> = ({ lesson, onDecide, onDecideReview, onScope, onTakeBack }) => (
    <div className="st-card mem-lesson">
        <LessonChips lesson={lesson} />
        <div className="mem-lesson-text">{inlineCode(lesson.text)}</div>
        {lesson.proposedBy && !lesson.yours && <div className="st-sub">Proposed by {lesson.proposedBy}</div>}
        {lesson.sharedBy && <div className="st-sub">Shared by {lesson.sharedBy}</div>}
        <div className="st-journey">
            <div style={{ background: 'var(--bg-surface)' }}><div className="st-sub">Learned</div><div style={{ fontSize: 14, marginTop: 4 }}>{lesson.learnedFrom}</div></div>
            <div><div className="st-sub">Agents told</div><div style={{ fontSize: 14, marginTop: 4 }}>{times(lesson.told)}</div></div>
            <div><div className="st-sub">Stopped in development</div><div style={{ fontSize: 14, marginTop: 4 }}>{times(lesson.stoppedInDevelopment, lesson.origin === 'development')}</div></div>
            <div><div className="st-sub">Reached a PR again</div><div style={{ fontSize: 14, marginTop: 4 }}>{times(lesson.reachedPr, lesson.origin === 'development')}</div></div>
        </div>
        {lesson.team && <TeamDecisions team={lesson.team} />}
        {lesson.takenBack && (
            <div style={{ marginTop: 14 }}>
                <div><span className="ui-chip warn">taken back</span> <span className="st-sub">{lesson.takenBack.detail}</span></div>
                <div className="st-row" style={{ marginTop: 10 }}>
                    <span className="st-sub">Later pull requests a review found repeating it merged and stayed fine. Keep telling agents anyway?</span>
                    <button className="st-btn primary" onClick={() => onDecideReview?.(lesson.id, 'accepted')} type="button">Promote again</button>
                    <button className="st-btn" onClick={() => onDecideReview?.(lesson.id, 'rejected')} type="button">Drop</button>
                </div>
            </div>
        )}
        {lesson.reclassified && (
            <div style={{ marginTop: 14 }}>
                <div><span className="ui-chip warn">back to candidate</span> <span className="st-sub">{lesson.reclassified.detail}</span></div>
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
                <div><span className="ui-chip">a later fix changed these lines</span> <span className="st-sub">{lesson.suggested.detail}</span></div>
                <div className="st-row" style={{ marginTop: 10 }}>
                    <span className="st-sub">The pull request (#{lesson.suggested.pr}) left this point alone, and a later fix changed its lines. If that fix is about this point, the lesson was right.</span>
                    <button className="st-btn primary" onClick={() => onDecideReview?.(lesson.id, 'accepted')} type="button">Promote</button>
                    <button className="st-btn" onClick={() => onDecideReview?.(lesson.id, 'dismissed')} type="button">Dismiss</button>
                </div>
            </div>
        )}
        {lesson.reach && <Reach lesson={lesson} reach={lesson.reach} onScope={onScope} />}
        {lesson.suggestedText && (
            <div style={{ marginTop: 14 }}>
                <div><span className="ui-chip">corrected wording ({lesson.suggestedText.why})</span> <span style={{ fontSize: 15 }}>{inlineCode(lesson.suggestedText.text)}</span></div>
                <div className="st-row" style={{ marginTop: 10 }}>
                    <span className="st-sub">You decided on this lesson as it reads above. A newer version reads its comment better; the lesson changes only if you take it.</span>
                    <button className="st-btn" onClick={() => onDecideReview?.(lesson.id, 'reworded')} type="button">Use this wording</button>
                </div>
            </div>
        )}
        {lesson.canDecide && lesson.origin === 'pr' && !lesson.takenBack && !lesson.suggested && !lesson.reclassified && (
            <div className="st-row" style={{ marginTop: 14 }}>
                <span className="st-sub">From review, not confirmed yet. Is this how your team works, so agents get told? A one-off task for that pull request is not a rule; Drop tells agents the team decided against it.</span>
                <button className="st-btn primary" onClick={() => onDecideReview?.(lesson.id, 'accepted')} type="button">Promote</button>
                <button className="st-btn" onClick={() => onDecideReview?.(lesson.id, 'not-a-rule')} type="button">Not a rule</button>
                <button className="st-btn" onClick={() => onDecideReview?.(lesson.id, 'rejected')} type="button" title="Agents are told the team decided against this">Drop</button>
            </div>
        )}
        {lesson.canTakeBack && (
            <div className="st-row" style={{ marginTop: 14 }}>
                <span className="st-sub">{TAKE_BACK_SAYS[lesson.state] ?? 'Decided.'} Changed your mind? Taking it back makes it a candidate again; the decision stays in its history.</span>
                <button className="st-btn" onClick={() => onDecideReview?.(lesson.id, 'took-back')} type="button">Take back</button>
            </div>
        )}
        {lesson.canRetire && (
            <div className="st-row" style={{ marginTop: 14 }}>
                <span className="st-sub">Shared with the team: every teammate's agent gets it. Taking it back stops that, and is recorded with your name.</span>
                <RetireButton id={lesson.id} onTakeBack={onTakeBack} />
            </div>
        )}
        {lesson.canDecide && lesson.origin !== 'pr' && !lesson.takenBack && !lesson.suggested && !lesson.reclassified && (
            <div className="st-row" style={{ marginTop: 14 }}>
                <span className="st-sub">{lesson.scope !== 'team' ? 'Seen once. Keep it so your agents get told?' : lesson.noShare ?? 'Proposed for the team. Give it to everyone\'s agents?'}</span>
                {!(lesson.scope === 'team' && lesson.noShare) && <button className="st-btn primary" onClick={() => onDecide(lesson.id, lesson.scope === 'team' ? 'promoted' : 'validated')} type="button">{lesson.scope === 'team' ? 'Share with team' : 'Keep'}</button>}
                <button className="st-btn" onClick={() => onDecide(lesson.id, 'rejected')} type="button">Drop</button>
            </div>
        )}
    </div>
);

const REACH_LABEL: Record<'file' | 'folder' | 'repo', string> = { file: 'its file', folder: 'its folder', repo: 'team standard' };

/** How far a review lesson reaches, and a person's choice to widen or narrow it (recorded with their git email). */
const Reach: React.FC<{ lesson: Journey; reach: NonNullable<Journey['reach']>; onScope?: (id: string, to: 'file' | 'folder' | 'repo') => void }> = ({ lesson, reach, onScope }) => {
    const choices: Array<['file' | 'folder' | 'repo', string]> = ([['repo', 'Make team standard'], ['folder', 'Folder only'], ['file', 'This file only']] as Array<['file' | 'folder' | 'repo', string]>)
        .filter(([to]) => to !== reach.scope && (reach.hasFile || to === 'repo'));
    return (
        <div className="st-row" style={{ marginTop: 12, flexWrap: 'wrap', gap: 8 }}>
            <span className="ui-chip">reaches: {reach.hasFile || reach.scope === 'repo' ? REACH_LABEL[reach.scope] : 'changes it is about'}</span>
            {choices.map(([to, label]) => <button key={to} className="st-btn" onClick={() => onScope?.(lesson.id, to)} type="button">{label}</button>)}
        </div>
    );
};

interface Share { count: number; of: number; rate: number | null }
/** The outcome numbers (core outcomes/metrics.ts), as Studio shows them. */
export interface OutcomeNumbers {
    records: { merged: number; settled: number; unsettled: number };
    settled: { ciRegressed: Share; ciUnknown: number; reverted: Share; fixedLater: Share; reviewed: { prs: number; fixedLater: Share }; notReviewed: { prs: number; fixedLater: Share } };
    lessons: { awaitingDecision: number; promotedFromEvidence: number; dismissed: number; takenBack: number };
    /** The model reviewer's share of findings and its dollars per pull request (core outcomes/metrics.ts); absent from older numbers. */
    model?: {
        share: { model: number; checks: number; prs: number; rate: number | null };
        costPerPr: { prs: number; totalUsd: number; medianUsd: number | null; prsEarlierBasis: number };
    };
}

/** What the model reviewer added beside the free checks, and what it cost: counts, a percentage and a median only from ten. */
const ModelNumbers: React.FC<{ model: NonNullable<OutcomeNumbers['model']> }> = ({ model: { share, costPerPr } }) => (
    <div className="st-sub" style={{ marginTop: 10, lineHeight: 1.6 }}>
        The model reviewer: {share.model} of {share.model + share.checks} findings at first review on {share.prs} pull request{share.prs === 1 ? '' : 's'}
        {share.rate === null ? '' : ` (${Math.round(share.rate * 100)}%)`}, the rest from the free checks.
        {' '}It cost ${costPerPr.totalUsd.toFixed(2)} over {costPerPr.prs} pull request{costPerPr.prs === 1 ? '' : 's'}{costPerPr.medianUsd === null ? '' : `, $${costPerPr.medianUsd.toFixed(2)} each at the median`}.
        {costPerPr.prsEarlierBasis ? ` ${costPerPr.prsEarlierBasis} more reviewed before every run was counted, left out.` : ''}
    </div>
);

/** A count, with a percentage only where there are enough records for one. */
const shareText = (s: Share) => `${s.count} of ${s.of}${s.rate === null ? '' : ` (${Math.round(s.rate * 100)}%)`}`;

/** What happened after merges: counts only. Reviewed and not reviewed side by side, never compared. */
export const OutcomeCard: React.FC<{ numbers: OutcomeNumbers }> = ({ numbers: m }) => (
    <section className="st-card">
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
        {m.model && <ModelNumbers model={m.model} />}
    </section>
);

export interface CompiledCheck {
    id: string;
    lessonId: string;
    files: string;
    kind: 'forbid' | 'require';
    symbol: string;
    with?: string;
    message: string;
    state: 'proposed' | 'active' | 'withdrawn';
    by?: string;
    /** Why an approved check no longer runs: its lesson no longer qualifies. */
    suspended?: string;
    /** The rate is computed by core, by its one RATE_MIN: null means a count only. */
    backtest?: { repeating: BacktestShare; other: BacktestShare; commits: number };
}

interface BacktestShare { fired: number; n: number; rate: number | null }
const share = (s: BacktestShare) => `${s.fired} of ${s.n}${s.rate === null ? '' : ` (${Math.round(s.rate * 100)}%)`}`;

/** Lessons compiled into checks that run without a model: what each reports, how it fired on history, and a person's decision. */
export const CompiledChecks: React.FC<{ checks: CompiledCheck[]; onDecide: (id: string, state: 'active' | 'withdrawn') => void; onPropose: () => void }> = ({ checks, onDecide, onPropose }) => (
    <section className="st-card">
        <div className="st-row" style={{ justifyContent: 'space-between' }}>
            <strong>Lessons compiled into checks</strong>
            <button className="st-btn" type="button" onClick={onPropose}>Propose checks</button>
        </div>
        <div className="st-sub" style={{ marginTop: 4, lineHeight: 1.6 }}>
            A verified lesson that names its file and symbols becomes a check that runs on every review, for free; the model reviewer stops spending prompt on it.
            A proposed check runs only once you approve it. Who approved it, by git email, is committed with it in <span className="st-mono">.rigour/compiled-checks.json</span>.
        </div>
        {checks.length === 0
            ? <div className="st-sub" style={{ marginTop: 10 }}>None yet. Propose checks once a lesson says never, avoid, instead of, always or must about a symbol in backticks.</div>
            : <div className="st-stack" style={{ marginTop: 12 }}>{checks.map(c => (
                <div key={c.id} className="st-need">
                    <div className="st-row" style={{ justifyContent: 'space-between' }}>
                        <span className={`ui-chip ${c.suspended ? 'bad' : c.state === 'active' ? 'ok' : c.state === 'proposed' ? 'warn' : ''}`}>{c.suspended ? 'suspended' : c.state}</span>
                        <span className="st-sub st-mono">{c.files}</span>
                    </div>
                    <div style={{ marginTop: 8 }}>{c.kind === 'forbid' ? <>Reports <code>{c.symbol}</code> on a changed line.</> : <>Reports <code>{c.symbol}</code> with no <code>{c.with}</code> within three lines.</>}</div>
                    <div className="st-sub" style={{ marginTop: 4 }}>{inlineCode(c.message)} · lesson {c.lessonId}{c.by ? ` · ${c.state === 'withdrawn' ? 'taken back' : 'approved'} by ${c.by}` : ''}</div>
                    {c.suspended && <div className="st-sub" style={{ marginTop: 6 }}>{c.suspended}</div>}
                    {c.backtest && (
                        <div className="st-sub" style={{ marginTop: 6, lineHeight: 1.6 }}>
                            On the last {c.backtest.commits} merged changes to its files: fires on {share(c.backtest.repeating)} where a review found the lesson repeating, and on {share(c.backtest.other)} others (each a false fire, or a catch the review missed).
                        </div>
                    )}
                    <div className="st-row" style={{ marginTop: 10, gap: 8 }}>
                        {c.state !== 'active' && <button className="st-btn" type="button" onClick={() => onDecide(c.id, 'active')}>Approve</button>}
                        {c.state === 'active' && <button className="st-btn" type="button" onClick={() => onDecide(c.id, 'withdrawn')}>Take back</button>}
                    </div>
                </div>
            ))}</div>}
    </section>
);
