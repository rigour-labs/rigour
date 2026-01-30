import React, { useState, useEffect } from 'react';
import {
    Activity,
    ShieldCheck,
    Database,
    Cpu,
    Terminal,
    Settings,
    Info,
    ChevronRight,
    Wifi,
    Lock,
    X,
    Folder,
    Sun,
    Moon,
    CheckCircle,
    XCircle,
    AlertTriangle
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { DiffEditor } from '@monaco-editor/react';
import { DiffViewer } from './components/DiffViewer';
import { FileTree } from './components/FileTree';
import { MemoryBank } from './components/MemoryBank';
import { PatternIndex } from './components/PatternIndex';
import { QualityGates } from './components/QualityGates';
import { AuditLog, LogEntry } from './components/AuditLog';

function App() {
    const [theme, setTheme] = useState(() => localStorage.getItem('rigour-theme') || 'dark');
    const [activeTab, setActiveTab] = useState('memory');
    const [logs, setLogs] = useState<any[]>([]);
    const [selectedDiff, setSelectedDiff] = useState<{
        filename: string;
        original: string;
        modified: string;
    } | null>(null);
    const [inspectingLog, setInspectingLog] = useState<any | null>(null);
    const [isGovernanceOpen, setIsGovernanceOpen] = useState(false);
    const [projectTree, setProjectTree] = useState<string[]>([]);
    const [projectInfo, setProjectInfo] = useState<{ name: string, path: string, version: string } | null>(null);

    React.useEffect(() => {
        const eventSource = new EventSource('/api/events');
        eventSource.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                setLogs(prev => [data, ...prev].slice(0, 100));
            } catch (e) {
                console.error('Failed to parse event', e);
            }
        };

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

        return () => eventSource.close();
    }, []);

    useEffect(() => {
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('rigour-theme', theme);
    }, [theme]);

    const toggleTheme = () => setTheme(t => t === 'dark' ? 'light' : 'dark');

    const [rigourConfig, setRigourConfig] = useState<string>('');
    const [memoryData, setMemoryData] = useState<any>({});
    const [indexStats, setIndexStats] = useState<any>({});

    useEffect(() => {
        const fetchMeta = async () => {
            try {
                const [cfg, mem, idx] = await Promise.all([
                    fetch('/api/config').then(r => r.ok ? r.text() : ''),
                    fetch('/api/memory').then(r => r.json()),
                    fetch('/api/index-stats').then(r => r.json())
                ]);
                setRigourConfig(cfg);
                setMemoryData(mem);
                setIndexStats(idx);
            } catch (err) {
                console.error('Failed to fetch meta data', err);
            }
        };
        fetchMeta();
    }, []);

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
        { id: 'audit', label: 'Audit Log', icon: Terminal },
        { id: 'gates', label: 'Quality Gates', icon: ShieldCheck },
        { id: 'patterns', label: 'Pattern Index', icon: Database },
        { id: 'memory', label: 'Memory Bank', icon: Cpu },
    ];

    return (
        <div className="studio">
            <aside className="sidebar">
                <div className="brand">
                    <div className="logo-icon"><ShieldCheck size={18} /></div>
                    <span>Rigour Studio</span>
                    <div className="version-pill">v{projectInfo?.version || '2.13'}</div>
                </div>

                <nav>
                    {navItems.map((item) => (
                        <button
                            key={item.id}
                            className={`nav-item ${activeTab === item.id ? 'active' : ''}`}
                            onClick={() => setActiveTab(item.id)}
                        >
                            <item.icon size={18} />
                            <span>{item.label}</span>
                            {activeTab === item.id && (
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
                    <button className="footer-item"><Settings size={18} /></button>
                    <button className="footer-item"><Info size={18} /></button>
                </div>
            </aside>

            <main className="main-content">
                <header>
                    <div className="header-left">
                        {projectInfo && (
                            <div className="project-identity">
                                <Folder size={14} className="folder-icon" />
                                <span className="project-name">{projectInfo.name}</span>
                                <span className="project-path">{projectInfo.path}</span>
                            </div>
                        )}
                    </div>
                    <div className="header-right">
                        <div className="connection-status">
                            <div className="status-indicator">
                                <div className="pulse-emitter" />
                                <span>LIVE</span>
                            </div>
                            <div className="v-divider" />
                            <span>v{projectInfo?.version || '0.0.0'}</span>
                        </div>
                        <button className="theme-toggle" onClick={toggleTheme}>
                            {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
                        </button>
                    </div>
                </header>

                <div className="view-container">
                    <AnimatePresence mode="wait">
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
                    </AnimatePresence>

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
                                                    <span>Critical actions should be manually verified.</span>
                                                </div>
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
