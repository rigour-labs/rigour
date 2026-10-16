/** A lesson's journey as the learning page draws it: where it was learned, what it stopped, and a person's decision. Learning.tsx loads the data. */
import React from 'react';
import { ago, inlineCode } from './storyData';
import { Chip, Clamp, MemoryText, StateChip, type Tone } from './ui';
import { lessonState, originNote, timesTold } from './lessonWords';
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

/** Where a lesson stands (one chip, the same words on every page) and whether it is working. */
const LessonChips: React.FC<{ lesson: Journey }> = ({ lesson }) => {
    const health = lessonHealth(lesson);
    return (
        <div className="mem-chips">
            <StateChip state={lessonState(lesson)} />
            {health && <span title={health.why}><Chip tone={health.tone}>{health.text}</Chip></span>}
        </div>
    );
};

/** What a decided review lesson is, beside its Take back. */
const TAKE_BACK_SAYS: Record<string, string> = { verified: 'Promoted: agents are told it.', rejected: 'Dropped: agents are told the team decided against it.', dropped: 'Not a rule: never told to agents.' };

/** A teammate's decision, in words. */
const TEAM_VERB: Record<string, string> = { accepted: 'accepted', rejected: 'rejected', dismissed: 'dismissed', scoped: 'set how far it reaches', reworded: 'reworded', compiled: 'decided its compiled check', 'not-a-rule': 'judged not a rule', 'took-back': 'took back the decision on' };

/** The team's decisions on a lesson, and, when a later one settled it against yours, both. */
const TeamDecisions: React.FC<{ team: NonNullable<Journey['team']> }> = ({ team }) => (
    <div className="mem-sub">
        {team.overruled && (
            <div>
                <Chip tone="warn">the team decided</Chip>{' '}
                <span className="ui-meta">
                    You {TEAM_VERB[team.overruled.yours] ?? team.overruled.yours} it{team.overruled.yoursOnly ? ` (yours only: ${team.overruled.yoursOnly})` : ''}; {team.overruled.team.name} {TEAM_VERB[team.overruled.team.kind] ?? team.overruled.team.kind} it {ago(team.overruled.team.at)}, and the team's decision is what agents are told.
                </span>
            </div>
        )}
        {team.decisions.map(d => (
            <div key={`${d.at}-${d.kind}-${d.name}`} className="ui-meta">
                {d.name} (team) {TEAM_VERB[d.kind] ?? d.kind} it {ago(d.at)}{d.detail ? `: ${d.detail}` : ''}
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

/** Take back a shared team memory: agents stop getting it. */
export const RetireButton: React.FC<{ id: string; onTakeBack?: (id: string) => void }> = ({ id, onTakeBack }) => (
    <button className="st-btn" onClick={() => onTakeBack?.(id)} type="button" title="Superseded when a newer shared version of its key exists, dropped otherwise">Take back</button>
);

type DecideReview = (id: string, decision: 'accepted' | 'rejected' | 'dismissed' | 'not-a-rule' | 'took-back' | 'reworded') => void;
/** `quietNoShare`: why sharing waits, said once above the list; rows with that same reason do not repeat it. */
interface LessonCardProps { quietNoShare?: string; lesson: Journey; onDecide: (id: string, state: 'validated' | 'promoted' | 'rejected') => void; onDecideReview?: DecideReview; onScope?: (id: string, to: 'file' | 'folder' | 'repo') => void; onTakeBack?: (id: string) => void }

/** Repeats are counted for lessons from fixes only: the three numbers of a fix lesson's journey. */
const FixJourney: React.FC<{ lesson: Journey }> = ({ lesson }) => (
    <div className="mem-journey">
        <div><span>Agents told</span><strong>{timesTold(lesson.told)}</strong></div>
        <div><span>Stopped in development</span><strong>{timesTold(lesson.stoppedInDevelopment)}</strong></div>
        <div><span>Reached a PR again</span><strong>{timesTold(lesson.reachedPr)}</strong></div>
    </div>
);

/** One lesson as a row: its text, one state chip, where it came from, and the decisions on the same line. */
export const LessonCard: React.FC<LessonCardProps> = props => {
    const { lesson } = props;
    const fix = lesson.origin === 'development';
    return (
        <div className="ui-list-row mem-lesson">
            <div className="mem-row-head">
                <MemoryText text={lesson.text} memoryKey={lesson.memory?.key} value={lesson.memory?.value} />
                <LessonChips lesson={lesson} />
            </div>
            {fix && <FixJourney lesson={lesson} />}
            {lesson.team && <TeamDecisions team={lesson.team} />}
            <ReviewEvidence {...props} />
            {lesson.reach && <Reach lesson={lesson} reach={lesson.reach} onScope={props.onScope} />}
            {actionHint(props) && <div className="ui-meta mem-hint">{actionHint(props)}</div>}
            <div className="ui-list-foot">
                <span className="ui-meta">{originNote(lesson)}{fix ? '' : ` · Agents told: ${timesTold(lesson.told)}`}</span>
                <LessonActions {...props} />
            </div>
        </div>
    );
};

/** What review evidence asks a person to decide again: taken back, back to a candidate, a later fix, a corrected wording. */
const ReviewEvidence: React.FC<LessonCardProps> = ({ lesson, onDecideReview }) => (
    <>
        {lesson.takenBack && (
            <div className="mem-sub">
                <div><Chip tone="warn">taken back</Chip> <span className="ui-meta">{lesson.takenBack.detail}</span></div>
                <div className="ui-list-foot">
                    <span className="ui-meta">Later pull requests a review found repeating it merged and stayed fine. Keep telling agents anyway?</span>
                    <div className="ui-actions">
                        <button className="st-btn primary" onClick={() => onDecideReview?.(lesson.id, 'accepted')} type="button">Promote again</button>
                        <button className="st-btn" onClick={() => onDecideReview?.(lesson.id, 'rejected')} type="button">Drop</button>
                    </div>
                </div>
            </div>
        )}
        {lesson.reclassified && (
            <div className="mem-sub">
                <div><Chip tone="warn">back to candidate</Chip> <span className="ui-meta">{lesson.reclassified.detail}</span></div>
                {lesson.reclassified.evidence.map(line => <div key={line} className="ui-meta">{line}</div>)}
                <div className="ui-list-foot">
                    <span className="ui-meta">A later fix on its lines used to make this a lesson by itself; now a person decides. Keep telling agents?</span>
                    <div className="ui-actions">
                        <button className="st-btn primary" onClick={() => onDecideReview?.(lesson.id, 'accepted')} type="button">Promote</button>
                        <button className="st-btn" onClick={() => onDecideReview?.(lesson.id, 'dismissed')} type="button">Dismiss</button>
                    </div>
                </div>
            </div>
        )}
        {lesson.suggested && (
            <div className="mem-sub">
                <div><Chip>a later fix changed these lines</Chip> <span className="ui-meta">{lesson.suggested.detail}</span></div>
                <div className="ui-list-foot">
                    <span className="ui-meta">The pull request (#{lesson.suggested.pr}) left this point alone, and a later fix changed its lines. If that fix is about this point, the lesson was right.</span>
                    <div className="ui-actions">
                        <button className="st-btn primary" onClick={() => onDecideReview?.(lesson.id, 'accepted')} type="button">Promote</button>
                        <button className="st-btn" onClick={() => onDecideReview?.(lesson.id, 'dismissed')} type="button">Dismiss</button>
                    </div>
                </div>
            </div>
        )}
        {lesson.suggestedText && (
            <div className="mem-sub">
                <div><Chip>corrected wording ({lesson.suggestedText.why})</Chip></div>
                <Clamp text={lesson.suggestedText.text} />
                <div className="ui-list-foot">
                    <span className="ui-meta">You decided on this lesson as it reads above. A newer version reads its comment better; the lesson changes only if you take it.</span>
                    <div className="ui-actions"><button className="st-btn" onClick={() => onDecideReview?.(lesson.id, 'reworded')} type="button">Use this wording</button></div>
                </div>
            </div>
        )}
    </>
);

/** A plain candidate a person decides on its row (evidence that asks again has its own buttons above). */
const awaitsDecision = (lesson: Journey) => lesson.canDecide && !lesson.takenBack && !lesson.suggested && !lesson.reclassified;

/** What the buttons on a lesson's row decide, said on its own line above them; undefined when the buttons say enough. */
function actionHint({ lesson, quietNoShare }: LessonCardProps): string | undefined {
    const pending = awaitsDecision(lesson);
    if (pending && lesson.origin === 'pr') return 'From review, not confirmed yet. Promote it if this is how your team works, so agents get told.';
    if (pending && lesson.scope === 'team' && lesson.noShare && lesson.noShare !== quietNoShare) return lesson.noShare;
    if (lesson.canTakeBack) return TAKE_BACK_SAYS[lesson.state] ?? 'Decided.';
    return undefined;
}

/** A review point waiting for a person: promote it, call it not a rule, or drop it. */
const ReviewDecide: React.FC<LessonCardProps> = ({ lesson, onDecideReview }) => (
    <>
        <button className="st-btn primary" onClick={() => onDecideReview?.(lesson.id, 'accepted')} type="button" title="From review, not confirmed yet: promote it if this is how your team works, so agents get told">Promote</button>
        <button className="st-btn" onClick={() => onDecideReview?.(lesson.id, 'not-a-rule')} type="button" title="A one-off task for that pull request: never told to agents">Not a rule</button>
        <button className="st-btn" onClick={() => onDecideReview?.(lesson.id, 'rejected')} type="button" title="Agents are told the team decided against this">Drop</button>
    </>
);

/** A fix or memory candidate: keep it (share it, for a team one, where this person may), or drop it. */
const CandidateDecide: React.FC<LessonCardProps> = ({ lesson, onDecide }) => {
    const team = lesson.scope === 'team';
    const blocked = team && lesson.noShare;
    return (
        <>
            {!blocked && (
                <button className="st-btn primary" onClick={() => onDecide(lesson.id, team ? 'promoted' : 'validated')} type="button"
                    title={team ? "Proposed for the team: give it to everyone's agents" : 'Seen once: keep it so your agents get told'}>{team ? 'Share with team' : 'Keep'}</button>
            )}
            <button className="st-btn" onClick={() => onDecide(lesson.id, 'rejected')} type="button">Drop</button>
        </>
    );
};

/** The decisions on the lesson's own row: keep, share or drop a candidate; promote a review point; take a decision back. */
const LessonActions: React.FC<LessonCardProps> = props => {
    const { lesson, onDecideReview, onTakeBack } = props;
    const pending = awaitsDecision(lesson);
    return (
        <div className="ui-actions">
            {pending && (lesson.origin === 'pr' ? <ReviewDecide {...props} /> : <CandidateDecide {...props} />)}
            {lesson.canTakeBack && (
                <button className="st-btn" onClick={() => onDecideReview?.(lesson.id, 'took-back')} type="button" title="Makes it a candidate again; the decision stays in its history">Take back</button>
            )}
            {lesson.canRetire && <RetireButton id={lesson.id} onTakeBack={onTakeBack} />}
        </div>
    );
};

const REACH_LABEL: Record<'file' | 'folder' | 'repo', string> = { file: 'its file', folder: 'its folder', repo: 'team standard' };

/** How far a review lesson reaches, and a person's choice to widen or narrow it (recorded with their git email). */
const Reach: React.FC<{ lesson: Journey; reach: NonNullable<Journey['reach']>; onScope?: (id: string, to: 'file' | 'folder' | 'repo') => void }> = ({ lesson, reach, onScope }) => {
    const choices: Array<['file' | 'folder' | 'repo', string]> = ([['repo', 'Make team standard'], ['folder', 'Folder only'], ['file', 'This file only']] as Array<['file' | 'folder' | 'repo', string]>)
        .filter(([to]) => to !== reach.scope && (reach.hasFile || to === 'repo'));
    return (
        <div className="mem-reach">
            <span className="ui-chip">reaches: {reach.hasFile || reach.scope === 'repo' ? REACH_LABEL[reach.scope] : 'changes it is about'}</span>
            {choices.map(([to, label]) => <button key={to} className="ui-link mem-reach-link" onClick={() => onScope?.(lesson.id, to)} type="button">{label}</button>)}
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
