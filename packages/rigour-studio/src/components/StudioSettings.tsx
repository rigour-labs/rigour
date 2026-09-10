import React from 'react';
import { Brain, Cloud, Database, Lock, Network } from 'lucide-react';
import type { HealthData } from './SystemHealth';

function SettingRow({ icon: Icon, title, detail, state, tone = 'ready' }: {
    icon: React.ElementType;
    title: string;
    detail: string;
    state: string;
    tone?: 'ready' | 'waiting';
}) {
    return <div className="setting-row">
        <Icon size={18} aria-hidden="true" />
        <div><strong>{title}</strong><span>{detail}</span></div>
        <em className={tone}>{state}</em>
    </div>;
}

export function StudioSettings({ health }: { health: HealthData | null }) {
    const team = health?.storage?.mode === 'team';
    const semanticReady = health?.semantic?.status === 'ready';
    const teamSemanticReady = health?.semantic?.provider === 'pgvector' && semanticReady;
    return <section className="studio-settings-view">
        <header className="page-intro">
            <span>Configuration</span>
            <h1>Local-first by default</h1>
            <p>Rigour works from SQLite without signup or cloud infrastructure. PostgreSQL and pgvector add shared team knowledge when you choose them.</p>
        </header>
        <div className="settings-card">
            <SettingRow icon={Database} title="SQLite intelligence store" detail="Scans, evidence, cache, checkpoints, patterns and personal lessons" state="Active" />
            <SettingRow icon={Brain} title="Local semantic enrichment" detail="Structural retrieval stays available while the on-device model warms" state={semanticReady ? 'Ready' : health?.semantic?.status || 'Warming'} tone={semanticReady ? 'ready' : 'waiting'} />
            <SettingRow icon={Cloud} title="PostgreSQL team mode" detail="Shared durability, stable identities, private namespaces and reviewed knowledge" state={team ? health?.storage?.connectivity || 'Configured' : 'Not configured'} tone={team ? 'ready' : 'waiting'} />
            <SettingRow icon={Network} title="pgvector team recall" detail="Optional ranking across validated personal and approved team lessons" state={teamSemanticReady ? 'Ready' : 'Optional'} tone={teamSemanticReady ? 'ready' : 'waiting'} />
            <SettingRow icon={Lock} title="Privacy boundary" detail="Code leaves this machine only when a cloud deep-analysis provider is explicitly enabled" state="Local default" />
        </div>
        <div className="settings-command"><span>Team diagnostics</span><code>rigour team doctor</code></div>
    </section>;
}
