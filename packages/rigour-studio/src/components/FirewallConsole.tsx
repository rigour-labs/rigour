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
    mediation?: { status?: string; typedCommands?: string; scopeEnforcement?: string; arbitration?: string; hooksInstalled?: boolean; mcpGateway?: 'not_configured' | 'configured' | 'observed' };
    gateway?: {
        configured: boolean;
        configurationError?: string;
        mode?: 'observe' | 'enforce';
        agentId?: string;
        taskId?: string;
        servers?: Array<{ name: string; allowedTools: number }>;
        toolCount?: number;
        chain: { valid: boolean; count: number; reason?: string };
        receipts: Array<{ id: string; operation: string; resource: string; actorId: string; taskId: string; mode: string; decision: string; simulatedDecision?: string; outcome: string; reason: string; capabilityId?: string; createdAt: string }>;
        capabilities: Array<{ id: string; action: string; resource: string; issuerId?: string; subjectId?: string; taskId?: string; parentCapabilityId?: string; expiresAt: number; used: boolean }>;
    };
}

function MediationPills({ data }: { data: FirewallPayload }) {
    const m = data.mediation;
    return (
        <div className="audit-stats">
            <div className="stat-pill"><Ban size={14} /> Fail-closed: {data.failClosed ? 'ON' : 'OFF'}</div>
            <div className="stat-pill">Status: {m?.status || 'unknown'}</div>
            <div className="stat-pill">Typed cmds: {String(m?.typedCommands ?? '—')}</div>
            <div className="stat-pill">Scope: {String(m?.scopeEnforcement ?? '—')}</div>
            <div className="stat-pill">Hooks: {m?.hooksInstalled ? 'installed' : 'missing'}</div>
            <div className="stat-pill">MCP gateway: {m?.mcpGateway === 'observed' ? 'activity observed' : m?.mcpGateway === 'configured' ? 'configured' : 'not configured'}</div>
            <div className="stat-pill">Arbitration: {m?.arbitration || '—'}</div>
        </div>
    );
}

function shortId(value?: string): string {
    return value ? `${value.slice(0, 8)}…` : '—';
}

function GatewayMetrics({ gateway }: { gateway: NonNullable<FirewallPayload['gateway']> }) {
    const delegated = gateway.capabilities.filter(capability => capability.parentCapabilityId).length;
    const available = gateway.capabilities.filter(capability => !capability.used && capability.expiresAt > Date.now()).length;
    return <div className="gateway-metrics">
        <span><b>{gateway.servers?.length ?? 0}</b><small>servers</small></span>
        <span><b>{gateway.toolCount ?? 0}</b><small>allowed tools</small></span>
        <span><b>{gateway.chain.count}</b><small>receipts</small></span>
        <span className={gateway.chain.valid ? 'verified' : 'invalid'}><b>{gateway.chain.valid ? 'Verified' : 'Broken'}</b><small>receipt chain</small></span>
        <span><b>{available}</b><small>live grants</small></span>
        <span><b>{delegated}</b><small>delegated</small></span>
    </div>;
}

function CapabilityLineage({ gateway }: { gateway: NonNullable<FirewallPayload['gateway']> }) {
    const delegated = gateway.capabilities.filter(capability => capability.parentCapabilityId);
    if (delegated.length === 0) return null;
    return <details className="capability-lineage">
        <summary>Capability lineage</summary>
        {delegated.map(capability => <div key={capability.id}>
            <code>{shortId(capability.parentCapabilityId)}</code><span>delegated to</span><code>{shortId(capability.id)}</code><small>{capability.subjectId}</small>
        </div>)}
    </details>;
}

function GatewayEvidenceCard({ gateway }: { gateway: NonNullable<FirewallPayload['gateway']> }) {
    if (!gateway.configured) return (
        <section className="gateway-evidence glass-card is-unconfigured">
            <div><Shield size={20} /><span><strong>Trusted MCP gateway</strong><small>Not configured for this repository</small></span></div>
            <p>{gateway.configurationError
                ? `Configuration is invalid: ${gateway.configurationError}`
                : 'Direct MCP connections remain outside Rigour. Configure the gateway in observe mode to measure impact before enforcement.'}</p>
        </section>
    );
    return (
        <section className="gateway-evidence glass-card">
            <header>
                <div><Shield size={20} /><span><strong>Trusted MCP gateway</strong><small>{gateway.agentId} · task {gateway.taskId}</small></span></div>
                <em className={gateway.mode === 'enforce' ? 'enforce' : 'observe'}>{gateway.mode}</em>
            </header>
            <div className="gateway-flow" aria-label="MCP mediation flow">
                <span>Agent</span><i>→</i><span>Capability</span><i>→</i><strong>Rigour</strong><i>→</i><span>Tool</span><i>→</i><span>Signed receipt</span>
            </div>
            {gateway.receipts.length === 0 && <div className="gateway-warning"><AlertTriangle size={15} />Configured, but no governed MCP activity has been observed yet.</div>}
            <GatewayMetrics gateway={gateway} />
            {!gateway.chain.valid && <div className="gateway-warning"><AlertTriangle size={15} />{gateway.chain.reason || 'Receipt chain verification failed.'}</div>}
            <p className="gateway-boundary">Evidence covers calls routed through this gateway. Direct MCP routes are not intercepted.</p>
            {gateway.receipts.length > 0 && <div className="gateway-receipts">
                <strong>Recent governed calls</strong>
                {gateway.receipts.slice(0, 8).map(receipt => <div key={receipt.id}>
                    <i className={receipt.outcome} />
                    <span><b>{receipt.operation}</b><small>{receipt.reason}</small></span>
                    <em>{receipt.simulatedDecision ? `would ${receipt.simulatedDecision}` : receipt.outcome}</em>
                    <code title={receipt.id}>{shortId(receipt.id)}</code>
                </div>)}
            </div>}
            <CapabilityLineage gateway={gateway} />
        </section>
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
            {data.gateway && <GatewayEvidenceCard gateway={data.gateway} />}
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
