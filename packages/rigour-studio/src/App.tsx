import React, { Suspense, useState, useEffect } from 'react';
import {
    Activity,
    ShieldCheck,
    Terminal,
    Settings,
    Info,
    Lock,
    X,
    Folder,
    Sun,
    Moon,
    CheckCircle,
    XCircle,
    AlertTriangle,
    Users,
    Brain,
    Network,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { DiffViewer } from './components/DiffViewer';
import { FileTree } from './components/FileTree';
import { MemoryBank } from './components/MemoryBank';
import { PatternIndex } from './components/PatternIndex';
import { QualityGates } from './components/QualityGates';
import { AuditLog, LogEntry } from './components/AuditLog';
import { AgentTeams } from './components/AgentTeams';
import { CheckpointTimeline } from './components/CheckpointTimeline';
import { DeepAnalysis } from './components/DeepAnalysis';
import { TemporalDrift } from './components/TemporalDrift';
import { CostContext } from './components/CostContext';
import { Overview } from './components/Overview';
import { EnforcementRail } from './components/EnforcementRail';
import { HandoffFlow } from './components/HandoffFlow';
import { LearningBrain } from './components/LearningBrain';
import { FirewallConsole } from './components/FirewallConsole';
import { ErrorBoundary } from './components/ErrorBoundary';
import { SystemHealth, type HealthData } from './components/SystemHealth';
import { StudioSettings } from './components/StudioSettings';

const KnowledgeGraph = React.lazy(() => import('./components/KnowledgeGraph').then(module => ({ default: module.KnowledgeGraph })));

interface ProjectInfo {
    name?: string;
    path?: string;
    projectName?: string;
    projectPath?: string;
    projectVersion?: string;
    version?: string;
    studioVersion?: string;
    mcpVersion?: string;
}

const tabTransition = {
    initial: { opacity: 0, y: 10 },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: -10 },
    transition: { duration: 0.28, ease: [0.16, 1, 0.3, 1] as const },
};

function App() {
    const [theme, setTheme] = useState(() => localStorage.getItem('rigour-theme') || 'dark');
    const [activeTab, setActiveTab] = useState('knowledge');
    const [logs, setLogs] = useState<any[]>([]);
    const [selectedDiff, setSelectedDiff] = useState<{
        filename: string;
        original: string;
        modified: string;
    } | null>(null);
    const [inspectingLog, setInspectingLog] = useState<any | null>(null);
    const [isGovernanceOpen, setIsGovernanceOpen] = useState(false);
    const [arbitrationSecondsLeft, setArbitrationSecondsLeft] = useState<number | null>(null);
    const [projectTree, setProjectTree] = useState<string[]>([]);
    const [projectInfo, setProjectInfo] = useState<ProjectInfo | null>(null);
    const [connectionState, setConnectionState] = useState<'connecting' | 'live' | 'offline'>('connecting');
    const [health, setHealth] = useState<HealthData | null>(null);
    const [healthLoading, setHealthLoading] = useState(true);
    const [healthUpdatedAt, setHealthUpdatedAt] = useState(0);
    const [healthOpen, setHealthOpen] = useState(false);

    const fetchHealth = React.useCallback(async () => {
        setHealthLoading(true);
        try {
            const response = await fetch('/api/health');
            const payload = await response.json();
            if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
            setHealth(payload);
            setHealthUpdatedAt(Date.now());
        } catch (error) {
            setHealth({ error: error instanceof Error ? error.message : String(error) });
        } finally {
            setHealthLoading(false);
        }
    }, []);

    React.useEffect(() => {
        const eventSource = new EventSource('/api/events');
        eventSource.onopen = () => setConnectionState('live');
        eventSource.onerror = () => setConnectionState('offline');
        eventSource.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                setLogs(prev => [data, ...prev].slice(0, 100));
            } catch (e) {
                console.error('Failed to parse event', e);
            }
        };
        void fetchHealth();
        const healthTimer = window.setInterval(fetchHealth, 15_000);

        // Fetch project tree
        fetch('/api/tree')
            .then(res => res.json())
            .then(setProjectTree)
            .catch(err => console.error('Failed to fetch tree', err));

        // Fetch project info
        fetch('/api/info')
            .then(res => res.json())
            .then(setProjectInfo)
            .catch(err => console.error('Failed to fetch info', err));

        return () => { eventSource.close(); window.clearInterval(healthTimer); };
    }, [fetchHealth]);

    useEffect(() => {
        if (!inspectingLog || inspectingLog.type !== 'interception_requested' || !isGovernanceOpen) {
            setArbitrationSecondsLeft(null);
            return;
        }
        const started = inspectingLog.timestamp ? Date.parse(inspectingLog.timestamp) : Date.now();
        const tick = () => {
            const elapsed = Math.floor((Date.now() - started) / 1000);
            const left = Math.max(0, 60 - elapsed);
            setArbitrationSecondsLeft(left);
        };
        tick();
        const id = setInterval(tick, 1000);
        return () => clearInterval(id);
    }, [inspectingLog, isGovernanceOpen]);

    useEffect(() => {
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('rigour-theme', theme);
    }, [theme]);

    const toggleTheme = () => setTheme(t => t === 'dark' ? 'light' : 'dark');

    const [rigourConfig, setRigourConfig] = useState<string>('');
    const [memoryData, setMemoryData] = useState<any>({});
    const [indexStats, setIndexStats] = useState<any>({});
    const [agentSession, setAgentSession] = useState<any>(null);
    const [checkpointSession, setCheckpointSession] = useState<any>(null);
    const [metaState, setMetaState] = useState<'loading' | 'ready' | 'degraded'>('loading');

    const fetchMeta = React.useCallback(async () => {
            setMetaState('loading');
            const results = await Promise.allSettled([
                    fetch('/api/config').then(r => r.ok ? r.text() : ''),
                    fetch('/api/memory').then(r => r.ok ? r.json() : Promise.reject(new Error(`Memory HTTP ${r.status}`))),
                    fetch('/api/index-stats').then(r => r.ok ? r.json() : Promise.reject(new Error(`Index HTTP ${r.status}`))),
                    fetch('/api/agents').then(r => r.ok ? r.json() : Promise.reject(new Error(`Agents HTTP ${r.status}`))),
                    fetch('/api/checkpoints').then(r => r.ok ? r.json() : Promise.reject(new Error(`Checkpoints HTTP ${r.status}`)))
                ]);
            if (results[0].status === 'fulfilled') setRigourConfig(results[0].value);
            if (results[1].status === 'fulfilled') setMemoryData(results[1].value);
            if (results[2].status === 'fulfilled') setIndexStats(results[2].value);
            if (results[3].status === 'fulfilled') setAgentSession(results[3].value);
            if (results[4].status === 'fulfilled') setCheckpointSession(results[4].value);
            setMetaState(results.every(result => result.status === 'fulfilled') ? 'ready' : 'degraded');
    }, []);

    useEffect(() => { void fetchMeta(); }, [fetchMeta]);

    const fetchFileContent = async (filename: string) => {
        try {
            // Strip line count annotation if present (e.g., "file.py (123 lines)")
            const cleanPath = filename.replace(/\s*\(\d+\s*lines\)$/, '');
            const res = await fetch(`/api/file?path=${encodeURIComponent(cleanPath)}`);
            const content = await res.text();
            setSelectedDiff({
                filename: cleanPath,
                original: content,
                modified: content
            });
        } catch (err) {
            console.error('Failed to fetch file content', err);
        }
    };

    const handleArbitration = async (decision: 'approve' | 'reject') => {
        if (!inspectingLog) return;

        try {
            await fetch('/api/arbitrate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    requestId: inspectingLog.requestId || inspectingLog.id,
                    decision,
                    token: inspectingLog.arbitrationToken,
                    timestamp: new Date().toISOString()
                })
            });

            // Optimistic update
            setLogs(prev => prev.map(l => {
                if ((l.requestId || l.id) === (inspectingLog.requestId || inspectingLog.id)) {
                    return { ...l, status: decision === 'approve' ? 'success' : 'error', arbitrated: true, decision };
                }
                return l;
            }));

            setIsGovernanceOpen(false);
            setInspectingLog(null);
        } catch (err) {
            console.error('Arbitration failed', err);
        }
    };

    const navItems = [
        { id: 'knowledge', label: 'Map', icon: Network, tabs: ['knowledge'] },
        { id: 'agents', label: 'Agents', icon: Users, tabs: ['agents', 'handoffs', 'checkpoints'] },
        { id: 'enforcement', label: 'Review', icon: ShieldCheck, tabs: ['enforcement', 'firewall', 'gates', 'audit'] },
        { id: 'learning', label: 'Knowledge', icon: Brain, tabs: ['learning', 'lessons', 'patterns', 'memory', 'cost', 'deep', 'drift'] },
        { id: 'settings', label: 'Settings', icon: Settings, tabs: ['settings'] },
    ];
    const sectionTabs: Record<string, Array<{ id: string; label: string }>> = {
        agents: [
            { id: 'agents', label: 'Agent history' },
            { id: 'handoffs', label: 'Handoffs' },
            { id: 'checkpoints', label: 'Checkpoints' },
        ],
        enforcement: [
            { id: 'enforcement', label: 'Enforcement' },
            { id: 'firewall', label: 'Firewall' },
            { id: 'gates', label: 'Quality gates' },
            { id: 'audit', label: 'Audit trail' },
        ],
        learning: [
            { id: 'learning', label: 'SME growth' },
            { id: 'lessons', label: 'Lessons' },
            { id: 'patterns', label: 'Patterns' },
            { id: 'memory', label: 'Memory' },
            { id: 'cost', label: 'Cost & context' },
            { id: 'deep', label: 'Deep analysis' },
            { id: 'drift', label: 'Drift' },
        ],
    };
    const activeNav = navItems.find((item) => item.tabs.includes(activeTab)) ?? navItems[0];

    const studioVersion = projectInfo?.studioVersion || projectInfo?.mcpVersion || '—';
    const projectVersion = projectInfo?.projectVersion || projectInfo?.version || '—';
    const projectName = projectInfo?.projectName || projectInfo?.name || 'project';
    const projectPath = projectInfo?.projectPath || projectInfo?.path || '';

    return (
        <div className="studio">
            <div className="cinema-ambient" aria-hidden="true">
                <div className="ambient-blob blob-a" />
                <div className="ambient-blob blob-b" />
            </div>
            <aside className="sidebar glass-shell">
                <div className="brand">
                    <div className="logo-icon"><ShieldCheck size={18} /></div>
                    <span>Rigour Studio</span>
                    <div className="version-pill">v{studioVersion}</div>
                </div>

                <nav>
                    {navItems.map((item) => (
                        <button
                            key={item.id}
                            className={`nav-item ${item.tabs.includes(activeTab) ? 'active' : ''}`}
                            onClick={() => setActiveTab(item.id)}
                        >
                            <item.icon size={18} />
                            <span>{item.label}</span>
                            {item.tabs.includes(activeTab) && (
                                <motion.div layoutId="nav-glow" className="nav-glow" />
                            )}
                        </button>
                    ))}
                </nav>

                <div className="sidebar-footer">
                    <div className="trust-indicator">
                        <Lock size={14} />
                        <span>Local Governance</span>
                    </div>
                    <button className="footer-item" onClick={() => setActiveTab('settings')} aria-label="Open settings"><Settings size={18} /></button>
                    <button className="footer-item"><Info size={18} /></button>
                </div>
            </aside>

            <main className="main-content">
                <header className="glass-shell">
                    <div className="header-left">
                        {projectInfo && (
                            <div className="project-identity">
                                <Folder size={14} className="folder-icon" />
                                <span className="project-name">{projectName}</span>
                                <span className="project-version-pill">v{projectVersion}</span>
                                <span className="project-path">{projectPath}</span>
                            </div>
                        )}
                    </div>
                    <div className="header-right">
                        <button type="button" className="connection-status" onClick={() => setHealthOpen(open => !open)} aria-expanded={healthOpen}>
                            <div className={`status-indicator ${connectionState}`}>
                                <div className="pulse-emitter" />
                                <span>{connectionState === 'live' && !health?.error ? 'CONNECTED' : connectionState.toUpperCase()}</span>
                            </div>
                        </button>
                        <button className="theme-toggle" onClick={toggleTheme} aria-label="Toggle theme">
                            {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
                        </button>
                    </div>
                </header>
                {healthOpen && <div className="health-popover"><div className="health-popover-title"><strong>Rigour system health</strong><button type="button" onClick={() => setHealthOpen(false)} aria-label="Close health"><X size={15} /></button></div><SystemHealth data={health} loading={healthLoading} stale={Boolean(healthUpdatedAt && Date.now() - healthUpdatedAt > 45_000)} onRetry={fetchHealth} /></div>}
                <div className="view-container">
                    {sectionTabs[activeNav.id] && (
                        <nav className="section-tabs" aria-label={`${activeNav.label} views`}>
                            {sectionTabs[activeNav.id].map((tab) => (
                                <button
                                    type="button"
                                    key={tab.id}
                                    className={activeTab === tab.id ? 'active' : ''}
                                    onClick={() => setActiveTab(tab.id)}
                                >
                                    {tab.label}
                                </button>
                            ))}
                        </nav>
                    )}
                    {metaState === 'loading' && <div className="overview-banner"><Activity size={18} className="spinning" /><div><strong>Loading workspace data</strong><p>Views will appear as their data becomes available.</p></div></div>}
                    {metaState === 'degraded' && <div className="overview-banner warn" role="alert"><AlertTriangle size={18} /><div><strong>Some workspace data is unavailable</strong><p>Available views remain usable.</p></div><button type="button" className="refresh-btn" onClick={fetchMeta}>Retry</button></div>}
                    <ErrorBoundary resetKey={activeTab}>
                    <AnimatePresence mode="wait">
                        {activeTab === 'enforcement' && (
                            <motion.div key="enforcement" {...tabTransition} className="full-view">
                                <EnforcementRail onNavigate={setActiveTab} />
                            </motion.div>
                        )}
                        {activeTab === 'firewall' && (
                            <motion.div key="firewall" {...tabTransition} className="full-view">
                                <FirewallConsole />
                            </motion.div>
                        )}
                        {activeTab === 'learning' && (
                            <motion.div key="learning" {...tabTransition} className="full-view">
                                <Suspense fallback={<div className="graph-state"><Activity size={18} className="spinning" /> Preparing expertise graph…</div>}>
                                    <KnowledgeGraph mode="expertise" onNavigate={setActiveTab} />
                                </Suspense>
                            </motion.div>
                        )}
                        {activeTab === 'lessons' && (
                            <motion.div key="lessons" {...tabTransition} className="full-view">
                                <LearningBrain onNavigate={setActiveTab} />
                            </motion.div>
                        )}
                        {activeTab === 'overview' && (
                            <motion.div key="overview" {...tabTransition} className="full-view">
                                <Overview onNavigate={setActiveTab} />
                            </motion.div>
                        )}
                        {activeTab === 'handoffs' && (
                            <motion.div key="handoffs" {...tabTransition} className="full-view">
                                <HandoffFlow />
                            </motion.div>
                        )}
                        {activeTab === 'audit' && (
                            <motion.div
                                key="audit"
                                initial={{ opacity: 0, y: 10 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: -10 }}
                                className="full-view"
                            >
                                <AuditLog
                                    logs={logs}
                                    onClearLogs={() => setLogs([])}
                                    onSelectLog={(log: LogEntry | null) => {
                                        setInspectingLog(log);
                                        // Open overlay for reports OR interception requests
                                        if (log?._rigour_report || log?.type === 'interception_requested') {
                                            if (log?._rigour_report) {
                                                const firstFile = log._rigour_report.failures?.[0]?.files?.[0];
                                                if (firstFile) fetchFileContent(firstFile);
                                                else setSelectedDiff(null);
                                            } else {
                                                setSelectedDiff(null);
                                            }
                                            setIsGovernanceOpen(true);
                                        } else {
                                            setSelectedDiff(null);
                                            setIsGovernanceOpen(false);
                                        }
                                    }}
                                    selectedLog={inspectingLog}
                                />
                            </motion.div>
                        )}
                        {activeTab === 'gates' && (
                            <motion.div
                                key="gates"
                                initial={{ opacity: 0, y: 10 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: -10 }}
                                className="full-view"
                            >
                                <QualityGates />
                            </motion.div>
                        )}

                        {activeTab === 'deep' && (
                            <motion.div
                                key="deep"
                                initial={{ opacity: 0, y: 10 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: -10 }}
                                className="full-view"
                            >
                                <DeepAnalysis />
                            </motion.div>
                        )}

                        {activeTab === 'drift' && (
                            <motion.div
                                key="drift"
                                initial={{ opacity: 0, y: 10 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: -10 }}
                                className="full-view"
                            >
                                <TemporalDrift />
                            </motion.div>
                        )}

                        {activeTab === 'patterns' && (
                            <motion.div
                                key="patterns"
                                initial={{ opacity: 0, y: 10 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: -10 }}
                                className="full-view"
                            >
                                <PatternIndex />
                            </motion.div>
                        )}

                        {activeTab === 'memory' && (
                            <motion.div
                                key="memory"
                                initial={{ opacity: 0, y: 10 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: -10 }}
                                className="full-view"
                            >
                                <MemoryBank />
                            </motion.div>
                        )}

                        {activeTab === 'agents' && (
                            <motion.div
                                key="agents"
                                initial={{ opacity: 0, y: 10 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: -10 }}
                                className="full-view"
                            >
                                <AgentTeams session={agentSession} />
                            </motion.div>
                        )}

                        {activeTab === 'knowledge' && (
                            <motion.div key="knowledge" {...tabTransition} className="full-view">
                                <Suspense fallback={<div className="graph-state"><Activity size={18} className="spinning" /> Preparing impact map…</div>}>
                                    <KnowledgeGraph />
                                </Suspense>
                            </motion.div>
                        )}

                        {activeTab === 'checkpoints' && (
                            <motion.div
                                key="checkpoints"
                                initial={{ opacity: 0, y: 10 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: -10 }}
                                className="full-view"
                            >
                                <CheckpointTimeline checkpoints={checkpointSession?.checkpoints || []} />
                            </motion.div>
                        )}

                        {activeTab === 'cost' && (
                            <motion.div
                                key="cost"
                                initial={{ opacity: 0, y: 10 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: -10 }}
                                className="full-view"
                            >
                                <CostContext />
                            </motion.div>
                        )}
                        {activeTab === 'settings' && (
                            <motion.div key="settings" {...tabTransition} className="full-view">
                                <StudioSettings health={health} />
                            </motion.div>
                        )}
                    </AnimatePresence>
                    </ErrorBoundary>

                    {inspectingLog && isGovernanceOpen && (
                        <div className="governance-overlay">
                            <div className="governance-window">
                                <div className="governance-header">
                                    <div className="title">
                                        <ShieldCheck size={20} />
                                        <span>Governance Audit: {inspectingLog.tool}</span>
                                    </div>
                                    <div className="hitl-actions">
                                        {inspectingLog.type === 'interception_requested' && (
                                            <>
                                                <button className="btn-approve" onClick={() => handleArbitration('approve')}>
                                                    <CheckCircle size={16} /> Approve
                                                </button>
                                                <button className="btn-reject" onClick={() => handleArbitration('reject')}>
                                                    <XCircle size={16} /> Reject
                                                </button>
                                                <div className="divider" />
                                            </>
                                        )}
                                        <button onClick={() => setIsGovernanceOpen(false)} className="close-btn"><X size={20} /></button>
                                    </div>
                                </div>
                                <div className="governance-body">
                                    {inspectingLog.type === 'interception_requested' ? (
                                        <div className="interception-view">
                                            <div className="interception-card">
                                                <Terminal size={48} />
                                                <h4>Command Intercepted</h4>
                                                <div className="command-box">
                                                    <code>{inspectingLog.command}</code>
                                                </div>
                                                <p>An AI agent is requesting to execute this command. Review the project state below before arbitrating.</p>
                                                <div className="warning-note">
                                                    <AlertTriangle size={16} />
                                                    <span>
                                                        Fail-closed: auto-DENY in {arbitrationSecondsLeft ?? 60}s if no decision.
                                                        Silent approve is disabled.
                                                    </span>
                                                </div>
                                                {inspectingLog.firewallDecision && inspectingLog.firewallDecision !== 'allow' && (
                                                    <div className="warning-note">
                                                        <XCircle size={16} />
                                                        <span>Pre-check: {inspectingLog.firewallDecision} — {inspectingLog.firewallReason}</span>
                                                    </div>
                                                )}
                                            </div>
                                            <FileTree
                                                files={projectTree.map((f: string) => f.replace(/\s*\(\d+\s*lines\)$/, ''))}
                                                onSelect={(file) => fetchFileContent(file)}
                                                activeFile={selectedDiff?.filename}
                                                violatedFiles={[]}
                                            />
                                        </div>
                                    ) : (
                                        <>
                                            <FileTree
                                                files={(inspectingLog._rigour_report?.failures?.flatMap((f: any) => f.files || []) || projectTree).map((f: string) => f.replace(/\s*\(\d+\s*lines\)$/, ''))}
                                                onSelect={(file) => fetchFileContent(file)}
                                                activeFile={selectedDiff?.filename}
                                                violatedFiles={(inspectingLog._rigour_report?.failures?.flatMap((f: any) => f.files || []) || []).map((f: string) => f.replace(/\s*\(\d+\s*lines\)$/, ''))}
                                            />
                                            <div className="diff-view-area">
                                                {selectedDiff ? (
                                                    <DiffViewer
                                                        filename={selectedDiff.filename}
                                                        originalCode={selectedDiff.original}
                                                        modifiedCode={selectedDiff.modified}
                                                        onClose={() => setSelectedDiff(null)}
                                                        theme={theme as 'dark' | 'light'}
                                                    />
                                                ) : (
                                                    <div className="diff-placeholder">
                                                        <Activity size={48} />
                                                        <p>Select a file to audit the proposed changes</p>
                                                    </div>
                                                )}
                                            </div>
                                        </>
                                    )}
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </main>
        </div>
    );
}

export default App;
