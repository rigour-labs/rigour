import React, { useCallback, useEffect, useState } from 'react';
import { Brain, GitPullRequest, Inbox, Landmark, Lock, Moon, PanelLeftClose, PanelLeftOpen, PenLine, Shapes, ShieldCheck, Sun, TrendingUp, Wrench, X } from 'lucide-react';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ProjectIdentity } from './components/ProjectIdentity';
import { ReadOnlyNote } from './components/ReadOnlyNote';
import { SystemHealth, type HealthData } from './components/SystemHealth';
import { Week } from './components/Week';
import { Progress } from './components/Progress';
import { Learning } from './components/Learning';
import { SetupView } from './components/SetupView';
import { WhileWriting } from './components/WhileWriting';
import { PullRequests } from './components/PullRequests';
import { Patterns } from './components/Patterns';
import { Governance } from './components/Governance';
import { Approval, type ApprovalRequest } from './components/Approval';
import { hasStudioKey } from './studioWrite';
import { Skeleton, setStorageRepository, usePersisted } from './components/ui';

// A new key: the old one holds the dark default every earlier Studio stored on first load.
const THEME_KEY = 'rigour-theme-v2';

interface ProjectInfo {
    projectName?: string;
    branch?: string | null;
    teamSync?: boolean;
    studioVersion?: string;
}

// In the order a person follows one change: what needs them, then development, the pull request, and what Rigour keeps.
const PAGES = [
    { id: 'week', group: 'work', label: 'This week', icon: Inbox, page: (go: (id: string) => void) => <Week onNavigate={go} /> },
    { id: 'writing', group: 'work', label: 'While writing', icon: PenLine, page: () => <WhileWriting /> },
    { id: 'pulls', group: 'work', label: 'Pull requests', icon: GitPullRequest, page: () => <PullRequests /> },
    { id: 'learns', group: 'knows', label: 'Memory', icon: Brain, page: () => <Learning /> },
    { id: 'patterns', group: 'knows', label: 'Patterns', icon: Shapes, page: () => <Patterns /> },
    { id: 'governance', group: 'team', label: 'Governance', icon: Landmark, page: (go: (id: string) => void) => <Governance onNavigate={go} /> },
    { id: 'progress', group: 'team', label: 'Progress', icon: TrendingUp, page: () => <Progress /> },
    { id: 'setup', group: 'team', label: 'Setup', icon: Wrench, page: () => <SetupView /> },
] as const;

const GROUPS = [
    { id: 'work', label: 'The work' },
    { id: 'knows', label: 'What Rigour knows' },
    { id: 'team', label: 'The team' },
] as const;

/** An approval request is shown only while an answer can still count. */
const APPROVAL_WINDOW_MS = 60_000;

/** The width at and below which the navigation can fold to an icon rail; index.css uses the same 960px. */
const NARROW = '(max-width: 960px)';

/** Whether the window is at or below the rail's width, following it as the window resizes. */
function useNarrow(): boolean {
    const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.(NARROW).matches);
    useEffect(() => {
        const query = window.matchMedia?.(NARROW);
        if (!query) return undefined;
        const onChange = () => setNarrow(query.matches);
        onChange();
        query.addEventListener('change', onChange);
        return () => query.removeEventListener('change', onChange);
    }, []);
    return narrow;
}

function App() {
    const [theme, setTheme] = useState(() => { try { return localStorage.getItem(THEME_KEY) || 'light'; } catch { return 'light'; } });
    const [active, setActive] = useState<string>('week');
    const [projectInfo, setProjectInfo] = useState<ProjectInfo | null>(null);
    // Pages wait for the repository's name: their remembered tabs and filters are kept per repository.
    const [infoRead, setInfoRead] = useState(false);
    const [connection, setConnection] = useState<'connecting' | 'live' | 'offline'>('connecting');
    const [approval, setApproval] = useState<ApprovalRequest | null>(null);
    const [health, setHealth] = useState<HealthData | null>(null);
    const [healthLoading, setHealthLoading] = useState(true);
    const [healthOpen, setHealthOpen] = useState(false);
    // At 960px and below the navigation is an icon rail unless the person opened it; wider screens always show it whole.
    // How the navigation shows is the same in every repository.
    const [nav, setNav] = usePersisted<string>('nav', 'rail', true);
    const narrow = useNarrow();
    const rail = nav !== 'full';
    const railShown = narrow && rail;

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
        fetch('/api/info').then(res => res.json())
            .then((info: ProjectInfo) => { setStorageRepository(info.projectName); setProjectInfo(info); })
            .catch(() => setProjectInfo(null))
            .finally(() => setInfoRead(true));
        return () => events.close();
    }, []);

    useEffect(() => {
        document.documentElement.setAttribute('data-theme', theme);
        try { localStorage.setItem(THEME_KEY, theme); } catch { /* not remembered */ }
    }, [theme]);

    const current = PAGES.find(p => p.id === active) ?? PAGES[0];
    return (
        <div className="studio" data-nav={rail ? 'rail' : 'full'}>
            <aside className="sidebar glass-shell">
                <div className="brand">
                    <div className="logo-icon"><ShieldCheck size={18} /></div>
                    <span>Rigour</span>
                    {projectInfo?.studioVersion && <div className="version-pill">v{projectInfo.studioVersion}</div>}
                </div>
                <button
                    type="button" className="nav-toggle" onClick={() => setNav(rail ? 'full' : 'rail')} aria-controls="studio-nav" aria-expanded={!rail}
                    aria-label={rail ? 'Show page names' : 'Hide page names'} title={rail ? 'Show page names' : 'Hide page names'}
                >{rail ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}</button>
                <nav id="studio-nav" aria-label="Pages">
                    {GROUPS.map(group => (
                        <div key={group.id} className="nav-group">
                            <div className="nav-group-label">{group.label}</div>
                            {PAGES.filter(page => page.group === group.id).map(page => (
                                <button key={page.id} className={`nav-item ${page.id === current.id ? 'active' : ''}`} onClick={() => setActive(page.id)} type="button" aria-label={page.label} title={railShown ? page.label : undefined} aria-current={page.id === current.id ? 'page' : undefined}>
                                    <page.icon size={18} />
                                    <span>{page.label}</span>
                                </button>
                            ))}
                        </div>
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
                        <div className="full-view">{infoRead ? current.page(setActive) : <Skeleton label="Loading Studio" />}</div>
                    </ErrorBoundary>
                </div>
            </main>
            {approval && <Approval request={approval} onClose={() => setApproval(null)} />}
        </div>
    );
}

export default App;
