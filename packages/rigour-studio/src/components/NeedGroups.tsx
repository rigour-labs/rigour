import React, { useState } from 'react';
import { studioWrite } from '../studioWrite';
import { ago, plural, STAGE_WORDS, type CatchStage } from './storyData';

/** Open findings grouped by check and message pattern, so 25 copies of one problem read as one line, not 25 cards. */
export interface OpenNeed { key?: string; file: string; rule: string; title: string; openedAt: string; stage?: CatchStage }
interface NeedGroup { rule: string; pattern: string; needs: OpenNeed[]; files: number }

/** A title with its specifics (quoted names, paths, numbers) taken out: "Import 'x' not found" and "Import 'y' not found" match. */
function messagePattern(title: string): string {
    return title
        .replace(/(['"`])(?:(?!\1).)*\1/g, '…')
        .replace(/\b\d+(?:\.\d+)?\b/g, 'N')
        .replace(/\s+/g, ' ')
        .trim();
}

/** Groups newest first by their newest finding; each group's findings newest first. */
export function groupNeeds(needs: OpenNeed[]): NeedGroup[] {
    const groups = new Map<string, NeedGroup>();
    const newestFirst = [...needs].sort((a, b) => Date.parse(b.openedAt) - Date.parse(a.openedAt));
    for (const need of newestFirst) {
        const pattern = messagePattern(need.title);
        const id = `${need.rule}\u0000${pattern}`;
        const group = groups.get(id) ?? { rule: need.rule, pattern, needs: [], files: 0 };
        group.needs.push(need);
        groups.set(id, group);
    }
    for (const group of groups.values()) group.files = new Set(group.needs.map(n => n.file)).size;
    return [...groups.values()];
}

/** One problem once: a single finding as its card; repeats as "25 × import not found, in 12 files", opened to the cards. */
export const NeedGroupCard: React.FC<{ group: NeedGroup; onDone: () => void }> = ({ group, onDone }) => {
    const [open, setOpen] = useState(false);
    if (group.needs.length === 1) return <NeedCard need={group.needs[0]} onDone={onDone} />;
    return (
        <div>
            <button className="st-story" onClick={() => setOpen(!open)} type="button" aria-expanded={open}>
                <div className="st-row" style={{ justifyContent: 'space-between' }}><span className="st-chip warn">open</span><span className="st-sub">newest {ago(group.needs[0].openedAt)}</span></div>
                <div style={{ fontSize: 17, marginTop: 10, lineHeight: 1.5 }}>{group.needs.length} × {group.pattern}, in {plural(group.files, 'file')}</div>
                <div className="st-mono st-sub" style={{ marginTop: 6 }}>{group.rule}</div>
            </button>
            {open && <div className="st-stack" style={{ marginTop: 10 }}>{group.needs.map(n => <NeedCard key={`${n.rule}:${n.file}:${n.openedAt}`} need={n} onDone={onDone} />)}</div>}
        </div>
    );
};

const NeedCard: React.FC<{ need: OpenNeed; onDone: () => void }> = ({ need, onDone }) => {
    const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
    const dismiss = async () => {
        const reason = window.prompt('Why is this not a bug? Rigour keeps the reason with the dismissal.');
        if (!reason?.trim() || !need.key) return;
        const res = await studioWrite('/api/dismiss', 'POST', JSON.stringify({ key: need.key, reason }));
        if (res.ok) onDone(); else setState('failed');
    };
    const copy = async () => {
        try {
            await navigator.clipboard.writeText(`Rigour found a problem you introduced: ${need.title} in ${need.file}. Fix it, then run rigour review.`);
            setState('copied');
        } catch { setState('failed'); }
    };
    return (
        <div className="st-need">
            <div className="st-row"><span className="st-chip warn">open</span><span className="st-sub">found {need.stage ? STAGE_WORDS[need.stage] : ''} · {ago(need.openedAt)}</span></div>
            <div style={{ fontSize: 17, marginTop: 10, lineHeight: 1.5 }}>{need.title}</div>
            <div className="st-mono st-sub" style={{ marginTop: 6 }}>{need.file}</div>
            <div className="st-row" style={{ marginTop: 14, flexWrap: 'wrap' }}>
                <button className="st-btn primary" onClick={copy} type="button">{state === 'copied' ? 'Copied: paste it to your agent' : 'Copy for my agent'}</button>
                {need.key && <button className="st-btn" onClick={dismiss} type="button">It's fine, not a bug</button>}
                {state === 'failed' && <span className="st-sub">That didn't work. Open Studio from the link in your terminal and try again.</span>}
            </div>
        </div>
    );
};
