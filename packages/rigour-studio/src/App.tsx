import React, { useCallback, useEffect, useState } from 'react';
import { Activity as ActivityIcon, Compass, GraduationCap, Inbox, ListChecks, Lock, Moon, ShieldCheck, Sun, TrendingUp, Trophy, Wrench, X } from 'lucide-react';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ProjectIdentity } from './components/ProjectIdentity';
import { ReadOnlyNote } from './components/ReadOnlyNote';
import { SystemHealth, type HealthData } from './components/SystemHealth';
import { Week } from './components/Week';
import { Progress } from './components/Progress';
import { OnlyRigour } from './components/OnlyRigour';
import { Learning } from './components/Learning';
import { AgentContext } from './components/AgentContext';
import { Reviews } from './components/Reviews';
import { Activity } from './components/Activity';
import { SetupView } from './components/SetupView';
import { Approval, type ApprovalRequest } from './components/Approval';
import { hasStudioKey } from './studioWrite';

// A new key: the old one holds the dark default every earlier Studio stored on first load.
const THEME_KEY = 'rigour-theme-v2';

interface ProjectInfo {
    projectName?: string;
    branch?: string | null;
    teamSync?: boolean;
    studioVersion?: string;
}

const PAGES = [
    { id: 'week', label: 'This week', icon: Inbox, page: (go: (id: string) => void) => <Week onNavigate={go} /> },
    { id: 'progress', label: 'Progress', icon: TrendingUp, page: () => <Progress /> },
    { id: 'only', label: 'Only Rigour', icon: Trophy, page: () => <OnlyRigour /> },
    { id: 'learns', label: 'How it learns', icon: GraduationCap, page: () => <Learning /> },
    { id: 'context', label: 'Agent context', icon: Compass, page: () => <AgentContext /> },
    { id: 'reviews', label: 'Review', icon: ListChecks, page: () => <Reviews /> },
    { id: 'activity', label: 'Activity', icon: ActivityIcon, page: () => <Activity /> },
    { id: 'setup', label: 'Setup', icon: Wrench, page: () => <SetupView /> },
] as const;

/** An approval request is shown only while an answer can still count. */
const APPROVAL_WINDOW_MS = 60_000;

function App() {
    const [theme, setTheme] = useState(() => { try { return localStorage.getItem(THEME_KEY) || 'light'; } catch { return 'light'; } });
    const [active, setActive] = useState<string>('week');
    const [projectInfo, setProjectInfo] = useState<ProjectInfo | null>(null);
    const [connection, setConnection] = useState<'connecting' | 'live' | 'offline'>('connecting');
    const [approval, setApproval] = useState<ApprovalRequest | null>(null);
    const [health, setHealth] = useState<HealthData | null>(null);
    const [healthLoading, setHealthLoading] = useState(true);
    const [healthOpen, setHealthOpen] = useState(false);

    const fetchHealth = useCallback(async () => {
        setHealthLoading(true);
        try {
            const response = await fetch('/api/health');
            const payload = await response.json();
            setHealth(response.ok ? payload : { error: payload.error || `HTTP ${response.status}` });
        } catch (error) {
            setHealth({ error: error instanceof Error ? error.message : String(error) });
        } finally {
            setHealthLoading(false);
        }
    }, []);

    useEffect(() => {
        const events = new EventSource('/api/events');
        events.onopen = () => setConnection('live');
        events.onerror = () => setConnection('offline');
        events.onmessage = (message) => {
            try {
                const event = JSON.parse(message.data);
                const fresh = !event.timestamp || Date.now() - Date.parse(event.timestamp) < APPROVAL_WINDOW_MS;
                if (event.type === 'interception_requested' && fresh) setApproval(event);
            } catch {
                // Not an event Studio understands; the pages read their own data.
            }
        };
        fetch('/api/info').then(res => res.json()).then(setProjectInfo).catch(() => setProjectInfo(null));
        return () => events.close();
    }, []);

    useEffect(() => {
        document.documentElement.setAttribute('data-theme', theme);
        try { localStorage.setItem(THEME_KEY, theme); } catch { /* not remembered */ }
    }, [theme]);

    const current = PAGES.find(p => p.id === active) ?? PAGES[0];
    return (
        <div className="studio">
            <aside className="sidebar glass-shell">
                <div className="brand">
                    <div className="logo-icon"><ShieldCheck size={18} /></div>
                    <span>Rigour</span>
                    {projectInfo?.studioVersion && <div className="version-pill">v{projectInfo.studioVersion}</div>}
                </div>
                <nav>
                    {PAGES.map(page => (
                        <button key={page.id} className={`nav-item ${page.id === current.id ? 'active' : ''}`} onClick={() => setActive(page.id)} type="button">
                            <page.icon size={18} />
                            <span>{page.label}</span>
                        </button>
                    ))}
                </nav>
                {projectInfo && (
                    <div className="sidebar-footer">
                        <div className="trust-indicator" title={projectInfo.teamSync ? 'Lessons your team promotes are shared through your team store' : 'Nothing leaves this machine'}>
                            <Lock size={14} />
                            <span>{projectInfo.teamSync ? 'Synced with your team' : 'Stored on this machine'}</span>
                        </div>
                    </div>
                )}
            </aside>

            <main className="main-content">
                <header className="glass-shell">
                    <div className="header-left">
                        {projectInfo && <ProjectIdentity name={projectInfo.projectName} branch={projectInfo.branch} />}
                    </div>
                    <div className="header-right">
                        <button type="button" className="connection-status" onClick={() => { setHealthOpen(open => !open); void fetchHealth(); }} aria-expanded={healthOpen} title="Studio receives Rigour's events live">
                            <div className={`status-indicator ${connection}`}>
                                <div className="pulse-emitter" />
                                <span>{connection === 'live' ? 'Live' : connection === 'offline' ? 'Offline' : 'Connecting'}</span>
                            </div>
                        </button>
                        <button className="theme-toggle" onClick={() => setTheme(t => (t === 'dark' ? 'light' : 'dark'))} aria-label="Toggle theme" type="button">
                            {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
                        </button>
                    </div>
                </header>
                {healthOpen && (
                    <div className="health-popover">
                        <div className="health-popover-title"><strong>Rigour system health</strong><button type="button" onClick={() => setHealthOpen(false)} aria-label="Close health"><X size={15} /></button></div>
                        <SystemHealth data={health} loading={healthLoading} stale={false} onRetry={fetchHealth} />
                    </div>
                )}
                <div className="view-container">
                    {!hasStudioKey() && <ReadOnlyNote />}
                    <ErrorBoundary resetKey={current.id}>
                        <div className="full-view">{current.page(setActive)}</div>
                    </ErrorBoundary>
                </div>
            </main>
            {approval && <Approval request={approval} onClose={() => setApproval(null)} />}
        </div>
    );
}

export default App;
