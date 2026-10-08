/** A switch (the goal check, ...), as Studio draws it: what runs and where it comes from, yours and the team's. Switch.tsx loads the data. */
import React from 'react';
import { Lock } from 'lucide-react';
import { Segmented, TeamDiff } from './ReviewerParts';
import './story.css';

type Source = 'flag' | 'env' | 'user' | 'team';
export interface SwitchData {
    effective: { enabled: boolean; source: Source; required: boolean; refused: string[] };
    team: 'off' | 'on' | 'required';
    teamFile: boolean;
    user: boolean | null;
}

const SOURCE: Record<Source, string> = { flag: 'this run', env: 'environment', user: 'yours', team: 'team' };

/** A switch's words: Switch.tsx keeps one set per switch. */
export interface SwitchText {
    title: string;
    lead: React.ReactNode;
    row: string;
    rowHelp: React.ReactNode;
    /** The control's name to assistive tech: "goal check" reads "Your goal check", "Team goal check". */
    name: string;
}

/** A switch's one setting, yours and the team's, with where the running value comes from. SwitchSetup loads the data. */
export const SwitchSettings: React.FC<{ text: SwitchText; data: SwitchData; canWrite: boolean; saving: boolean; problem: string | null; diff: string | null; onSave: (payload: Record<string, unknown>) => void }> = ({ text, data, canWrite, saving, problem, diff, onSave }) => {
    const e = data.effective;
    const locked = e.required ? `your team requires the ${text.name}` : undefined;
    return (
        <section style={{ marginTop: 32 }}>
            <h2 style={{ margin: '0 0 6px', fontSize: 18, fontWeight: 600 }}>{text.title}</h2>
            <p className="st-sub" style={{ margin: '0 0 12px', lineHeight: 1.6 }}>
                {text.lead}
                {!canWrite && ' Open Studio from the link the terminal printed to change it here.'}
            </p>
            <div className="st-card st-setting">
                <div>
                    <div style={{ fontSize: 15 }}>{text.row}</div>
                    <div className="st-sub" style={{ marginTop: 4, lineHeight: 1.5 }}>{text.rowHelp}</div>
                </div>
                <div className="st-setting-controls">
                    <span className="st-sub">Runs</span>
                    <span><span className="st-mono">{e.enabled ? 'on' : 'off'}</span> <span className="st-sub">· {SOURCE[e.source]}</span>{locked && <span title={locked} aria-label={locked}> <Lock size={12} /></span>}</span>
                    <span className="st-sub">Yours</span>
                    <Segmented label={`Your ${text.name}`} withTeam disabled={!canWrite || saving} value={data.user ?? undefined}
                        options={[{ value: true, label: 'on' }, { value: false, label: 'off' }]} onChange={value => onSave({ user: value })} />
                    <span className="st-sub">Team</span>
                    <Segmented label={`Team ${text.name}`} disabled={!canWrite || saving} value={data.team}
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
