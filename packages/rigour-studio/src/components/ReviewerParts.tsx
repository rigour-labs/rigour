/** The reviewer, as Studio draws it: the verdict, the settings with their sources, and the agent CLIs. Reviewer.tsx loads the data. */
import React, { useState } from 'react';
import { Lock } from 'lucide-react';
import { studioWrite } from '../studioWrite';
import { ago, plural } from './storyData';
import './story.css';

interface Item { id: string; kind: string; class: string; file?: string; line?: number; issue: string; consequence?: string; evidence?: string; reviewer?: string }
interface ModeRecord { asked: string; ran: string; source: string; degraded?: string; escalation?: string; refused?: string[] }
type Source = 'flag' | 'env' | 'user' | 'team';
export interface ReviewerData {
    branch: string;
    status: { running?: { head: string }; attempt?: { head: string; outcome: 'unavailable' | 'skipped'; reason: string; at: string }; last?: { head: string; at: string; mode: string; open: Item[]; disputed: Item[]; ran?: ModeRecord } } | null;
    effective: { enabled: boolean; mode: string; panel: boolean; judges: number; escalate: string; dismissals: boolean; reviewers: string[]; source: { mode: Source; panel: Source }; required: { mode: boolean; panel: boolean }; refused: string[] };
    team: Record<string, unknown>;
    teamFile: boolean;
    user: Record<string, unknown>;
    available: Array<{ name: string; vendor: string; binary: string; installed: boolean; version?: string }>;
}

const RAN: Record<string, string> = { single: 'one judge', cross: 'one judge from another vendor', full: 'one judge per vendor, findings merged', panel: 'a panel: only what a majority confirms blocks' };
const where = (item: Item) => (item.file ? `${item.file}${item.line ? `:${item.line}` : ''}` : '');

export const Verdict: React.FC<{ data: ReviewerData; canWrite: boolean; onChange: () => void }> = ({ data, canWrite, onChange }) => {
    const last = data.status?.last;
    return (
        <section style={{ marginTop: 24 }}>
            <h2 style={{ margin: '0 0 12px', fontSize: 18, fontWeight: 600 }}>The reviewer's verdict on {data.branch}</h2>
            {data.status?.running && <div className="st-sub" style={{ marginBottom: 8 }}>Reviewing {data.status.running.head.slice(0, 9)} now.</div>}
            {data.status?.attempt && (
                <div className="st-card" style={{ marginBottom: 12 }}>
                    <span className="st-chip warn">{data.status.attempt.outcome === 'skipped' ? 'skipped' : 'could not run'}</span>{' '}
                    <span className="st-sub">The last review, of {data.status.attempt.head.slice(0, 9)} {ago(data.status.attempt.at)}: {data.status.attempt.reason}</span>
                </div>
            )}
            {!last ? (!data.status?.attempt && <div className="st-empty">No verdict yet. Run <span className="st-mono">rigour review --reviewer</span>, or push with the reviewer on.</div>) : (
                <div className="st-stack">
                    <div className="st-card st-row" style={{ justifyContent: 'space-between' }}>
                        <span>
                            <span className={`st-chip ${last.open.length ? 'bad' : 'ok'}`}>{last.open.length ? `${plural(last.open.length, 'finding')} to fix` : 'nothing to fix'}</span>{' '}
                            <span className="st-sub">{last.ran ? `${RAN[last.ran.ran] ?? last.ran.ran}, ` : ''}{last.mode === 'delta' ? 'new commits' : 'the whole branch'} at {last.head.slice(0, 9)}, {ago(last.at)}</span>
                        </span>
                    </div>
                    {last.ran && (last.ran.degraded || last.ran.escalation || last.ran.asked !== last.ran.ran) && (
                        <div className="st-sub">Asked for {RAN[last.ran.asked] ?? last.ran.asked} ({last.ran.source}); ran {RAN[last.ran.ran] ?? last.ran.ran}. {[last.ran.degraded, last.ran.escalation].filter(Boolean).join('; ')}</div>
                    )}
                    {last.open.map(item => <Finding key={item.id} item={item} canWrite={canWrite && data.effective.dismissals} onChange={onChange} />)}
                    {last.disputed.length > 0 && <div className="st-sub" style={{ marginTop: 8 }}>No majority, so these never block:</div>}
                    {last.disputed.map(item => <Finding key={item.id} item={item} disputed canWrite={false} onChange={onChange} />)}
                </div>
            )}
        </section>
    );
};

const Finding: React.FC<{ item: Item; disputed?: boolean; canWrite: boolean; onChange: () => void }> = ({ item, disputed, canWrite, onChange }) => {
    const [reason, setReason] = useState('');
    const [open, setOpen] = useState(false);
    const [problem, setProblem] = useState<string | null>(null);
    const dismiss = async () => {
        const res = await studioWrite('/api/reviewer/dismiss', 'POST', JSON.stringify({ id: item.id, reason }));
        if (res.ok) onChange();
        else setProblem((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
    };
    return (
        <div className="st-card">
            <div className="st-row" style={{ justifyContent: 'space-between', gap: 12 }}>
                <strong style={{ fontSize: 14 }}>{item.issue}</strong>
                <span className="st-mono st-sub">{where(item)}</span>
            </div>
            <div className="st-sub" style={{ marginTop: 6 }}>
                {disputed ? <span className="st-chip warn">disputed</span> : <span className="st-chip">{item.class}</span>}
                {item.reviewer && <> found by {item.reviewer.split('+').join(' and ')}</>}
            </div>
            {item.consequence && <div style={{ marginTop: 8, fontSize: 14 }}>What goes wrong: {item.consequence}</div>}
            {item.evidence && <div className="st-mono st-sub" style={{ marginTop: 6 }}>{item.evidence}</div>}
            {canWrite && item.kind !== 'prior' && (open ? (
                <div className="st-row" style={{ marginTop: 10, gap: 8 }}>
                    <input aria-label="Why it is not a bug" value={reason} onChange={e => setReason(e.target.value)} placeholder="Why it is not a bug" style={{ flex: 1, minHeight: 36, padding: '0 10px', borderRadius: 8, border: '1px solid var(--text-dim)', background: 'var(--bg-card)', color: 'var(--text-primary)' }} />
                    <button className="st-btn" disabled={reason.trim().length < 5} onClick={dismiss}>Dismiss</button>
                </div>
            ) : <button className="st-btn" style={{ marginTop: 10 }} onClick={() => setOpen(true)}>Not a bug</button>)}
            {problem && <div className="st-sub" style={{ marginTop: 6 }}><span className="st-chip bad">not dismissed</span> {problem}</div>}
        </div>
    );
};

/** A choice among a few values, as one row of pills; for your own setting, "Team" first clears it. A radio group to assistive tech. */
const Segmented: React.FC<{ label: string; value: unknown; options: Array<{ value: unknown; label: string }>; disabled: boolean; withTeam?: boolean; onChange: (value: unknown) => void }> = ({ label, value, options, disabled, withTeam, onChange }) => {
    const all = withTeam ? [{ value: null as unknown, label: 'Team' }, ...options] : options;
    const chosen = value === undefined ? null : value;
    return (
        <div className="st-seg" role="radiogroup" aria-label={label}>
            {all.map(o => {
                const on = JSON.stringify(o.value) === JSON.stringify(chosen);
                return (
                    <button key={o.label} type="button" role="radio" aria-checked={on} className={on ? 'on' : ''} disabled={disabled} onClick={() => !on && onChange(o.value)}>
                        {o.label}
                    </button>
                );
            })}
        </div>
    );
};

interface Option { value: unknown; label: string }
interface Row { key: string; label: string; help: string; effective: string; user?: { value: unknown; options: Option[] }; team: { value: unknown; options: Option[] }; locked?: string }

const SOURCE: Record<Source, string> = { flag: 'this run', env: 'environment', user: 'yours', team: 'team' };

/** Where the running value comes from: the resolver says for mode and panel (a panel makes the mode full); otherwise yours when you chose. */
function sourceOf(r: Row, e: ReviewerData['effective']): Source {
    if (r.key === 'mode') return e.source.mode;
    if (r.key === 'panel') return e.source.panel;
    if (r.key === 'escalate' && (e.required.panel || e.required.mode)) return 'team'; // the team's floor runs every judge
    return r.user && r.user.value !== undefined ? 'user' : 'team';
}

const on: Option[] = [{ value: true, label: 'on' }, { value: false, label: 'off' }];
const modes: Option[] = [{ value: 'single', label: 'one judge' }, { value: 'cross', label: 'one, another vendor' }, { value: 'full', label: 'one per vendor' }];

export const Settings: React.FC<{ data: ReviewerData; canWrite: boolean; saving: string | null; onSave: (patch: Record<string, unknown>) => void; onSaveTeam: (patch: Record<string, unknown>, create: boolean) => void }> = ({ data, canWrite, saving, onSave, onSaveTeam }) => {
    const [creating, setCreating] = useState(false);
    const e = data.effective;
    const t = data.team;
    const floor = e.required.panel || e.required.mode;
    const rows: Row[] = [
        { key: 'enabled', label: 'Review at push', help: 'Ask the reviewer when you push a branch that has an open pull request.', effective: e.enabled ? 'on' : 'off', user: { value: data.user.enabled, options: on }, team: { value: t.enabled ?? false, options: on } },
        { key: 'mode', label: 'Mode', help: 'One judge; one from a vendor that did not write the code; or one judge per vendor (up to Judges), findings merged.', effective: e.mode, user: { value: data.user.mode, options: modes }, team: { value: t.mode ?? 'single', options: modes }, locked: e.required.mode ? 'your team requires at least this' : undefined },
        { key: 'mode_required', label: 'Required for everyone', help: 'No person or run may review with fewer judges than the team\'s, in CI or anywhere.', effective: e.required.mode ? 'yes' : 'no', team: { value: t.mode_required ?? false, options: [{ value: true, label: 'yes' }, { value: false, label: 'no' }] } },
        { key: 'panel', label: 'Panel', help: 'Judges cross-examine what only one of them found; only what a majority confirms blocks. Required: no one may turn it off.', effective: e.panel ? 'on' : 'off', user: { value: data.user.panel, options: on }, team: { value: t.panel ?? 'off', options: [{ value: 'off', label: 'off' }, { value: 'on', label: 'on' }, { value: 'required', label: 'required' }] }, locked: e.required.panel ? 'your team requires the panel' : undefined },
        { key: 'dismissals', label: 'Dismissals', help: 'Whether people may mark a reviewer finding "not a bug". Off: a wrong finding is fixed by improving the reviewer, a right one by fixing the code.', effective: e.dismissals ? 'allowed' : 'off', team: { value: t.dismissals ?? false, options: [{ value: true, label: 'allowed' }, { value: false, label: 'off' }] } },
        { key: 'judges', label: 'Judges', help: 'How many judges a full or panel review uses, each from a different vendor. Three give a real majority.', effective: String(e.judges), user: { value: data.user.judges, options: [{ value: 2, label: '2' }, { value: 3, label: '3' }] }, team: { value: t.judges ?? 2, options: [{ value: 2, label: '2' }, { value: 3, label: '3' }] } },
        { key: 'escalate', label: 'When to add judges', help: 'Always, or only for a risky change or one a person has reviewed. The backtest shows whether that loses anything.', effective: e.escalate, user: { value: data.user.escalate, options: [{ value: 'always', label: 'always' }, { value: 'risk', label: 'when risky' }] }, team: { value: t.escalate ?? 'always', options: [{ value: 'always', label: 'always' }, { value: 'risk', label: 'when risky' }] }, locked: floor ? 'your team requires every review to be full' : undefined },
    ];
    const teamEditable = canWrite && (data.teamFile || creating);
    return (
        <>
            <p className="st-sub" style={{ margin: '0 0 12px', lineHeight: 1.6 }}>
                <strong>Yours</strong> applies to your own runs, in every repository on this machine, and wins over the team's except where the team set a floor. <strong>Team</strong> is{' '}
                {data.teamFile ? <>in <span className="st-mono">rigour.yml</span>: a change here edits the file, and you commit it</> : <>Rigour's defaults: this repository has no <span className="st-mono">rigour.yml</span></>}.
                {!canWrite && ' Open Studio from the link the terminal printed to change settings here.'}
            </p>
            {canWrite && !data.teamFile && !creating && (
                <div className="st-card st-row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
                    <span className="st-sub">Setting team defaults creates a <span className="st-mono">rigour.yml</span>: from then on this repository uses the team setup.</span>
                    <button className="st-btn" onClick={() => setCreating(true)}>Set team defaults</button>
                </div>
            )}
            <div className="st-stack">
                {rows.map(r => (
                    <div className="st-card st-setting" key={r.key}>
                        <div>
                            <div style={{ fontSize: 15 }}>{r.label}</div>
                            <div className="st-sub" style={{ marginTop: 4, lineHeight: 1.5 }}>{r.help}</div>
                        </div>
                        <div className="st-setting-controls">
                            <span className="st-sub">Runs</span>
                            <span><span className="st-mono">{r.effective}</span> <span className="st-sub">· {SOURCE[sourceOf(r, e)]}</span>{r.locked && <span title={r.locked} aria-label={r.locked}> <Lock size={12} /></span>}</span>
                            <span className="st-sub">Yours</span>
                            {r.user ? <Segmented label={`Your ${r.label}`} withTeam disabled={!canWrite || saving !== null} value={r.user.value} options={r.user.options} onChange={value => onSave({ [r.key]: value })} /> : <span className="st-sub">set by the team only</span>}
                            <span className="st-sub">Team</span>
                            <Segmented label={`Team ${r.label}`} disabled={!teamEditable || saving !== null} value={r.team.value} options={r.team.options} onChange={value => onSaveTeam({ [r.key]: value }, !data.teamFile)} />
                        </div>
                    </div>
                ))}
            </div>
            {e.refused.length > 0 && <div className="st-stack" style={{ marginTop: 12 }}>{e.refused.map(line => <div key={line} className="st-sub"><span className="st-chip warn">not applied</span> {line}</div>)}</div>}
        </>
    );
};

export const Agents: React.FC<{ data: ReviewerData }> = ({ data }) => {
    // Only the reviewers this repository's settings name can be judges.
    const vendors = new Set(data.available.filter(a => a.installed && data.effective.reviewers.includes(a.name)).map(a => a.vendor)).size;
    const floor = data.effective.required.panel || data.effective.required.mode;
    return (
        <section style={{ marginTop: 20 }}>
            <h3 style={{ margin: '0 0 6px', fontSize: 15, fontWeight: 600 }}>Agent CLIs on this machine</h3>
            <p className="st-sub" style={{ margin: '0 0 12px' }}>
                The reviewer uses their own logins: no API key. {vendors >= 3 ? 'Enough vendors for three judges.' : vendors === 2 ? 'Enough for two judges; a third vendor, listed in the reviewers, allows three.' : floor ? 'Your team requires two judges from different vendors: with one, the review cannot run until another is installed.' : 'Two judges need two vendors; with one, the review runs with one judge and says so.'}
            </p>
            <div className="st-row" style={{ flexWrap: 'wrap', gap: 8 }}>
                {data.available.map(a => <span key={a.name} className={`st-chip ${a.installed ? 'ok' : ''}`}>{a.binary}{a.installed ? ` ${a.version ?? ''}` : ': not installed'}</span>)}
            </div>
        </section>
    );
};
