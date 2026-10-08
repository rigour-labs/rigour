/** The goal check, as Studio draws it: what runs and where it comes from, yours and the team's. Goal.tsx loads the data. */
import React from 'react';
import { Lock } from 'lucide-react';
import { Segmented, TeamDiff } from './ReviewerParts';
import './story.css';

type Source = 'flag' | 'env' | 'user' | 'team';
export interface GoalData {
    effective: { enabled: boolean; source: Source; required: boolean; refused: string[] };
    team: 'off' | 'on' | 'required';
    teamFile: boolean;
    user: boolean | null;
}

const SOURCE: Record<Source, string> = { flag: 'this run', env: 'environment', user: 'yours', team: 'team' };

/** The goal check's one setting, yours and the team's, with where the running value comes from. GoalSetup loads the data. */
export const GoalSettings: React.FC<{ data: GoalData; canWrite: boolean; saving: boolean; problem: string | null; diff: string | null; onSave: (payload: Record<string, unknown>) => void }> = ({ data, canWrite, saving, problem, diff, onSave }) => {
    const e = data.effective;
    const locked = e.required ? 'your team requires the goal check' : undefined;
    return (
        <section style={{ marginTop: 32 }}>
            <h2 style={{ margin: '0 0 6px', fontSize: 18, fontWeight: 600 }}>The goal check</h2>
            <p className="st-sub" style={{ margin: '0 0 12px', lineHeight: 1.6 }}>
                Checks a change against what its pull request says it is for: files outside its <span className="st-mono">Scope</span> or inside <span className="st-mono">Out of scope</span>, and
                {' '}<span className="st-mono">Done when</span> items naming a file it never touched, block. No model; a description without these sections is never checked.
                {!canWrite && ' Open Studio from the link the terminal printed to change it here.'}
            </p>
            <div className="st-card st-setting">
                <div>
                    <div style={{ fontSize: 15 }}>Check the goal</div>
                    <div className="st-sub" style={{ marginTop: 4, lineHeight: 1.5 }}>Required: no person, environment variable or flag may turn it off. <span className="st-mono">--goal</span> and <span className="st-mono">--no-goal</span> choose for one run.</div>
                </div>
                <div className="st-setting-controls">
                    <span className="st-sub">Runs</span>
                    <span><span className="st-mono">{e.enabled ? 'on' : 'off'}</span> <span className="st-sub">· {SOURCE[e.source]}</span>{locked && <span title={locked} aria-label={locked}> <Lock size={12} /></span>}</span>
                    <span className="st-sub">Yours</span>
                    <Segmented label="Your goal check" withTeam disabled={!canWrite || saving} value={data.user ?? undefined}
                        options={[{ value: true, label: 'on' }, { value: false, label: 'off' }]} onChange={value => onSave({ user: value })} />
                    <span className="st-sub">Team</span>
                    <Segmented label="Team goal check" disabled={!canWrite || saving} value={data.team}
                        options={[{ value: 'off', label: 'off' }, { value: 'on', label: 'on' }, { value: 'required', label: 'required' }]}
                        onChange={value => onSave({ team: value, create: !data.teamFile })} />
                </div>
            </div>
            {!data.teamFile && canWrite && <div className="st-sub" style={{ marginTop: 8 }}>This repository has no <span className="st-mono">rigour.yml</span>: setting the team's value creates one, and from then on it uses the team setup.</div>}
            {e.refused.length > 0 && <div className="st-stack" style={{ marginTop: 12 }}>{e.refused.map(line => <div key={line} className="st-sub"><span className="st-chip warn">not applied</span> {line}</div>)}</div>}
            {problem && <div className="st-card" style={{ marginTop: 12 }}><span className="st-chip bad">not saved</span> <span className="st-sub">{problem}</span></div>}
            {diff && <TeamDiff diff={diff} />}
        </section>
    );
};
