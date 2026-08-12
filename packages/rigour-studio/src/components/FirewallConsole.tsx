import React, { useEffect, useState } from 'react';
import { Shield, Ban, CheckCircle, Clock, FileKey, AlertTriangle, RefreshCw } from 'lucide-react';

interface FirewallPayload {
    current?: {
        id: string;
        status: string;
        scope: string[];
        filesChanged: string[];
        budgets?: { maxFiles: number; maxRetries: number; maxDurationMs: number };
        worktreePath?: string;
    } | null;
    attestation?: {
        transactionId: string;
        policyHash: string;
        signature: string;
        gateResults: { status: string; score?: number };
        artifactDigest: string;
        signedAt: string;
    } | null;
    attestationValid?: boolean;
    adversarial?: { passed: number; failed: number } | null;
    decisions?: Array<{ decision: string; reason: string; ruleId?: string; timestamp: string }>;
    recentDenies?: Array<{ type?: string; reason?: string; decision?: string; command?: string }>;
    failClosed?: boolean;
    mediation?: { typedCommands: boolean; scopeEnforcement: boolean; arbitration: string };
}

function MediationPills({ data }: { data: FirewallPayload }) {
    const m = data.mediation;
    return (
        <div className="audit-stats">
            <div className="stat-pill"><Ban size={14} /> Fail-closed: {data.failClosed ? 'ON' : 'OFF'}</div>
            <div className="stat-pill">Typed cmds: {m?.typedCommands ? 'ON' : 'OFF'}</div>
            <div className="stat-pill">Scope: {m?.scopeEnforcement ? 'ENFORCED' : 'OFF'}</div>
            <div className="stat-pill">Arbitration: {m?.arbitration || '—'}</div>
        </div>
    );
}

function CurrentTransactionCard({ current }: { current: FirewallPayload['current'] }) {
    return (
        <div className="glass-card" style={{ marginTop: 16, padding: 16 }}>
            <h3><Clock size={16} /> Current transaction</h3>
            {!current && <p style={{ opacity: 0.7 }}>No active transaction. Run <code>rigour firewall transact</code>.</p>}
            {current && (
                <div>
                    <code>{current.id}</code> — <strong>{current.status}</strong>
                    <div style={{ marginTop: 8, opacity: 0.8 }}>Scope: {current.scope?.join(', ') || '—'}</div>
                    <div style={{ opacity: 0.8 }}>
                        Files: {current.filesChanged?.length ?? 0}
                        {current.budgets ? ` / max ${current.budgets.maxFiles}` : ''}
                    </div>
                    {current.worktreePath && (
                        <div style={{ fontSize: 12, opacity: 0.7 }}>Worktree: {current.worktreePath}</div>
                    )}
                </div>
            )}
        </div>
    );
}

function AttestationCard({ attestation, valid }: { attestation: FirewallPayload['attestation']; valid?: boolean }) {
    return (
        <div className="glass-card" style={{ marginTop: 16, padding: 16 }}>
            <h3><FileKey size={16} /> Attestation</h3>
            {!attestation && <p style={{ opacity: 0.7 }}>No attestation yet.</p>}
            {attestation && (
                <div>
                    <div>
                        {valid ? <CheckCircle size={14} color="#34d399" /> : <Ban size={14} color="#f87171" />}
                        {' '}Signature {valid ? 'valid' : 'invalid'} — gates {attestation.gateResults.status}
                    </div>
                    <div style={{ fontSize: 12, opacity: 0.75, marginTop: 6 }}>
                        policy={attestation.policyHash} digest={attestation.artifactDigest.slice(0, 16)}…
                    </div>
                </div>
            )}
        </div>
    );
}

function DecisionList({
    title,
    empty,
    items,
}: {
    title: string;
    empty: string;
    items: Array<{ primary: string; secondary: string }>;
}) {
    return (
        <div className="glass-card" style={{ marginTop: 16, padding: 16 }}>
            <h3>{title}</h3>
            {items.length === 0 && <p style={{ opacity: 0.7 }}>{empty}</p>}
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {items.map((d, i) => (
                    <li key={i} style={{ padding: '8px 0', borderBottom: '1px solid rgba(127,127,127,0.2)' }}>
                        <strong>{d.primary}</strong> — {d.secondary}
                    </li>
                ))}
            </ul>
        </div>
    );
}

export function FirewallConsole() {
    const [data, setData] = useState<FirewallPayload | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);

    const load = async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await fetch('/api/firewall');
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json = await res.json();
            if (json.error) throw new Error(json.error);
            setData(json);
        } catch (e: any) {
            setError(e.message || 'Failed to load firewall status');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        load();
        const t = setInterval(load, 5000);
        return () => clearInterval(t);
    }, []);

    if (loading && !data) {
        return <div className="empty-state glass-card"><RefreshCw className="spin" /> Loading firewall…</div>;
    }
    if (error) {
        return <div className="empty-state glass-card"><AlertTriangle /> {error}</div>;
    }
    if (!data) return null;

    const decisions = (data.decisions || []).slice(0, 30).map(d => ({
        primary: `${d.decision}${d.ruleId ? ` (${d.ruleId})` : ''}`,
        secondary: d.reason,
    }));
    const denies = (data.recentDenies || []).slice(0, 20).map(d => ({
        primary: d.decision || d.type || 'deny',
        secondary: d.reason || d.command || '—',
    }));

    return (
        <div className="firewall-console">
            <div className="audit-header">
                <div className="audit-title">
                    <Shield size={24} />
                    <h2>Agent Transaction Firewall</h2>
                </div>
                <button className="btn-secondary" onClick={load}><RefreshCw size={16} /> Refresh</button>
            </div>
            <MediationPills data={data} />
            <CurrentTransactionCard current={data.current} />
            <AttestationCard attestation={data.attestation} valid={data.attestationValid} />
            <div className="glass-card" style={{ marginTop: 16, padding: 16 }}>
                <h3>Adversarial replay</h3>
                {data.adversarial ? (
                    <div><strong>{data.adversarial.passed}</strong> passed / <strong>{data.adversarial.failed}</strong> failed</div>
                ) : (
                    <p style={{ opacity: 0.7 }}>Run <code>rigour firewall adversarial</code>.</p>
                )}
            </div>
            <DecisionList title="Capability / policy decisions" empty="No broker decisions logged yet." items={decisions} />
            <DecisionList title="Recent denies" empty="No firewall denies in the event stream." items={denies} />
        </div>
    );
}
