import React, { useEffect, useState } from 'react';
import { RefreshCw, Scale, VolumeX } from 'lucide-react';

export interface CheckPrecisionRow {
    check: string;
    fixed: number;
    dismissed: number;
    precision: number;
    muted: boolean;
}

interface Payload {
    checks: CheckPrecisionRow[];
    muteBelow: number;
    muteMinOutcomes: number;
}

/**
 * How this repository treats each check: findings fixed versus dismissed, as a Beta posterior
 * (rigour precision). Advisory checks the team keeps dismissing are muted; proven checks never are.
 */
export const CheckPrecision: React.FC = () => {
    const [data, setData] = useState<Payload | null>(null);
    const [loading, setLoading] = useState(true);

    const load = async () => {
        setLoading(true);
        try {
            const res = await fetch('/api/check-precision');
            setData(res.ok ? await res.json() : null);
        } catch {
            setData(null);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => { void load(); }, []);

    const checks = data?.checks ?? [];
    return (
        <div className="memory-bank">
            <div className="memory-header">
                <div className="memory-title">
                    <Scale size={18} />
                    <h2>Check precision</h2>
                    <span className="memory-count">{checks.length} checks with outcomes</span>
                </div>
                <div className="memory-actions">
                    <button className="refresh-btn" onClick={load} disabled={loading}>
                        <RefreshCw size={16} className={loading ? 'spinning' : ''} />
                    </button>
                </div>
            </div>
            <p className="section-body">
                The chance a finding from each check is worth acting on here: (fixed + 1) / (fixed + dismissed + 2).
                {data ? ` Advisory checks below ${Math.round(data.muteBelow * 100)}% after ${data.muteMinOutcomes}+ outcomes are muted; proven checks never are.` : ''}
            </p>
            {checks.length === 0 ? (
                <div className="empty-state">
                    No outcomes yet. Every finding an agent fixes, and every <code>rigour dismiss</code>, is counted here per check.
                </div>
            ) : (
                <ul className="precision-list">
                    {checks.map(row => <PrecisionRow key={row.check} row={row} />)}
                </ul>
            )}
        </div>
    );
};

export const PrecisionRow: React.FC<{ row: CheckPrecisionRow }> = ({ row }) => {
    const pct = Math.round(row.precision * 100);
    return (
        <li className="precision-row" data-muted={row.muted || undefined}>
            <span className="precision-pct">{pct}%</span>
            <span className="precision-bar" aria-hidden="true"><span style={{ width: `${pct}%` }} /></span>
            <span className="precision-check">{row.check}</span>
            <span className="precision-counts">{row.fixed} fixed · {row.dismissed} dismissed</span>
            {row.muted && <span className="precision-muted"><VolumeX size={12} /> muted</span>}
        </li>
    );
};
