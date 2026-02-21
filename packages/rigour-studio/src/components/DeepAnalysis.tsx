import React, { useState, useEffect } from 'react';
import {
    Brain,
    RefreshCw,
    Shield,
    AlertTriangle,
    CheckCircle,
    XCircle,
    ChevronDown,
    ChevronRight,
    FileCode,
    Zap,
    Layers,
    Target,
    Clock,
    Filter,
    Eye
} from 'lucide-react';

interface DeepFinding {
    id: string;
    title: string;
    details: string;
    severity?: 'critical' | 'high' | 'medium' | 'low' | 'info';
    provenance?: string;
    files?: string[];
    line?: number;
    endLine?: number;
    hint?: string;
    confidence?: number;
    source?: 'ast' | 'llm' | 'hybrid';
    category?: string;
    verified?: boolean;
}

interface DeepStats {
    enabled: boolean;
    tier?: string;
    model?: string;
    total_ms?: number;
    files_analyzed?: number;
    findings_count?: number;
    findings_verified?: number;
}

interface ReportData {
    score?: number;
    ai_health_score?: number;
    structural_score?: number;
    code_quality_score?: number;
    deep?: DeepStats;
    severity_breakdown?: Record<string, number>;
    provenance_breakdown?: Record<string, number>;
    findings: DeepFinding[];
}

const SEVERITY_COLORS: Record<string, string> = {
    critical: 'var(--status-error)',
    high: '#f97316',
    medium: 'var(--status-warning)',
    low: 'var(--accent-primary)',
    info: 'var(--text-dim)',
};

const CATEGORY_LABELS: Record<string, string> = {
    srp_violation: 'Single Responsibility',
    ocp_violation: 'Open/Closed Principle',
    lsp_violation: 'Liskov Substitution',
    isp_violation: 'Interface Segregation',
    dip_violation: 'Dependency Inversion',
    god_class: 'God Class',
    god_function: 'God Function',
    long_params: 'Long Parameters',
    complex_conditional: 'Complex Conditional',
    empty_catch: 'Empty Catch Block',
    error_inconsistency: 'Error Inconsistency',
    race_condition: 'Race Condition',
    goroutine_leak: 'Goroutine Leak',
    channel_misuse: 'Channel Misuse',
    mutex_scope: 'Mutex Scope',
    isp_violation_interface: 'Interface Bloat',
    missing_test: 'Missing Tests',
    long_file: 'Long File',
    magic_number: 'Magic Numbers',
    resource_leak: 'Resource Leak',
    dry_violation: 'DRY Violation',
    feature_envy: 'Feature Envy',
    dead_code: 'Dead Code',
    naming_convention: 'Naming Convention',
    performance: 'Performance',
};

const CATEGORY_GROUPS: Record<string, string[]> = {
    'SOLID Principles': ['srp_violation', 'ocp_violation', 'lsp_violation', 'isp_violation', 'dip_violation'],
    'Code Smells': ['god_class', 'god_function', 'long_params', 'complex_conditional', 'long_file', 'magic_number', 'dead_code', 'feature_envy'],
    'Error Handling': ['empty_catch', 'error_inconsistency'],
    'Concurrency': ['race_condition', 'goroutine_leak', 'channel_misuse', 'mutex_scope'],
    'Testing': ['missing_test'],
    'Architecture': ['isp_violation_interface', 'dry_violation', 'naming_convention', 'resource_leak'],
    'Performance': ['performance'],
};

export const DeepAnalysis: React.FC = () => {
    const [data, setData] = useState<ReportData | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
    const [expandedFindings, setExpandedFindings] = useState<Set<string>>(new Set());
    const [severityFilter, setSeverityFilter] = useState<string>('all');
    const [verifiedOnly, setVerifiedOnly] = useState(false);

    const fetchData = async () => {
        setIsLoading(true);
        try {
            const [statsRes, findingsRes] = await Promise.all([
                fetch('/api/report-stats'),
                fetch('/api/deep-findings'),
            ]);
            const stats = statsRes.ok ? await statsRes.json() : {};
            const findings = findingsRes.ok ? await findingsRes.json() : [];
            setData({ ...stats, findings });
        } catch (err) {
            console.error('Failed to fetch deep analysis data:', err);
        }
        setIsLoading(false);
    };

    useEffect(() => {
        fetchData();
    }, []);

    const toggleGroup = (group: string) => {
        setExpandedGroups(prev => {
            const next = new Set(prev);
            if (next.has(group)) next.delete(group);
            else next.add(group);
            return next;
        });
    };

    const toggleFinding = (id: string) => {
        setExpandedFindings(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const deepFindings = (data?.findings || []).filter(f => f.provenance === 'deep-analysis');
    const filtered = deepFindings.filter(f => {
        if (severityFilter !== 'all' && f.severity !== severityFilter) return false;
        if (verifiedOnly && !f.verified) return false;
        return true;
    });

    const groupedFindings = Object.entries(CATEGORY_GROUPS).map(([group, categories]) => {
        const groupFindings = filtered.filter(f => categories.includes(f.category || ''));
        return { group, findings: groupFindings };
    }).filter(g => g.findings.length > 0);

    // Ungrouped findings (categories not in any group)
    const allGroupedCats = Object.values(CATEGORY_GROUPS).flat();
    const ungrouped = filtered.filter(f => !allGroupedCats.includes(f.category || ''));

    const deep = data?.deep;

    return (
        <div className="deep-analysis">
            <div className="deep-header">
                <div className="deep-title">
                    <Brain size={24} />
                    <h2>Deep Analysis</h2>
                    {deep?.tier && <span className="tier-badge">{deep.tier}</span>}
                </div>
                <div className="deep-actions">
                    <button className="refresh-btn" onClick={fetchData} disabled={isLoading}>
                        <RefreshCw size={16} className={isLoading ? 'spinning' : ''} />
                    </button>
                </div>
            </div>

            {isLoading ? (
                <div className="deep-loading">Loading deep analysis data...</div>
            ) : !deep?.enabled && deepFindings.length === 0 ? (
                <div className="deep-empty">
                    <Brain size={48} />
                    <h3>Deep Analysis Not Yet Run</h3>
                    <p>Run <code>rigour check --deep</code> to get LLM-powered code quality analysis with 40+ categories.</p>
                    <div className="empty-features">
                        <div className="feature"><Shield size={16} /> SOLID Principles</div>
                        <div className="feature"><Layers size={16} /> Design Patterns</div>
                        <div className="feature"><Zap size={16} /> Concurrency Safety</div>
                        <div className="feature"><Target size={16} /> Architecture Quality</div>
                    </div>
                </div>
            ) : (
                <>
                    {/* Stats Banner */}
                    <div className="deep-stats-banner">
                        <div className="stat-card">
                            <span className="stat-value">{deep?.findings_count ?? deepFindings.length}</span>
                            <span className="stat-label">Findings</span>
                        </div>
                        <div className="stat-card">
                            <span className="stat-value">{deep?.findings_verified ?? deepFindings.filter(f => f.verified).length}</span>
                            <span className="stat-label">Verified</span>
                        </div>
                        <div className="stat-card">
                            <span className="stat-value">{deep?.files_analyzed ?? '—'}</span>
                            <span className="stat-label">Files Analyzed</span>
                        </div>
                        <div className="stat-card">
                            <span className="stat-value">{deep?.model || '—'}</span>
                            <span className="stat-label">Model</span>
                        </div>
                        {deep?.total_ms && (
                            <div className="stat-card">
                                <span className="stat-value">{(deep.total_ms / 1000).toFixed(1)}s</span>
                                <span className="stat-label">Inference</span>
                            </div>
                        )}
                    </div>

                    {/* Score Cards */}
                    {(data?.score !== undefined || data?.code_quality_score !== undefined) && (
                        <div className="deep-scores">
                            {data?.score !== undefined && (
                                <ScoreRing label="Overall" score={data.score} />
                            )}
                            {data?.ai_health_score !== undefined && (
                                <ScoreRing label="AI Health" score={data.ai_health_score} />
                            )}
                            {data?.structural_score !== undefined && (
                                <ScoreRing label="Structural" score={data.structural_score} />
                            )}
                        </div>
                    )}

                    {/* Filters */}
                    <div className="deep-filters">
                        <div className="filter-group">
                            <Filter size={14} />
                            <select
                                value={severityFilter}
                                onChange={e => setSeverityFilter(e.target.value)}
                                className="filter-select"
                            >
                                <option value="all">All Severities</option>
                                <option value="critical">Critical</option>
                                <option value="high">High</option>
                                <option value="medium">Medium</option>
                                <option value="low">Low</option>
                            </select>
                        </div>
                        <button
                            className={`filter-toggle ${verifiedOnly ? 'active' : ''}`}
                            onClick={() => setVerifiedOnly(!verifiedOnly)}
                        >
                            <CheckCircle size={14} />
                            Verified Only
                        </button>
                        <span className="filter-count">{filtered.length} finding{filtered.length !== 1 ? 's' : ''}</span>
                    </div>

                    {/* Findings by Category Group */}
                    <div className="deep-findings">
                        {groupedFindings.map(({ group, findings }) => (
                            <div key={group} className="finding-group">
                                <button
                                    className="group-header"
                                    onClick={() => toggleGroup(group)}
                                >
                                    {expandedGroups.has(group) ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                                    <span className="group-name">{group}</span>
                                    <span className="group-count">{findings.length}</span>
                                    <div className="group-severity-dots">
                                        {['critical', 'high', 'medium', 'low'].map(sev => {
                                            const count = findings.filter(f => f.severity === sev).length;
                                            return count > 0 ? (
                                                <span key={sev} className="sev-dot" style={{ backgroundColor: SEVERITY_COLORS[sev] }} title={`${count} ${sev}`} />
                                            ) : null;
                                        })}
                                    </div>
                                </button>
                                {expandedGroups.has(group) && (
                                    <div className="group-findings">
                                        {findings.map(finding => (
                                            <FindingCard
                                                key={finding.id}
                                                finding={finding}
                                                expanded={expandedFindings.has(finding.id)}
                                                onToggle={() => toggleFinding(finding.id)}
                                            />
                                        ))}
                                    </div>
                                )}
                            </div>
                        ))}

                        {ungrouped.length > 0 && (
                            <div className="finding-group">
                                <button className="group-header" onClick={() => toggleGroup('_other')}>
                                    {expandedGroups.has('_other') ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                                    <span className="group-name">Other Findings</span>
                                    <span className="group-count">{ungrouped.length}</span>
                                </button>
                                {expandedGroups.has('_other') && (
                                    <div className="group-findings">
                                        {ungrouped.map(finding => (
                                            <FindingCard
                                                key={finding.id}
                                                finding={finding}
                                                expanded={expandedFindings.has(finding.id)}
                                                onToggle={() => toggleFinding(finding.id)}
                                            />
                                        ))}
                                    </div>
                                )}
                            </div>
                        )}

                        {filtered.length === 0 && (
                            <div className="no-findings">
                                <CheckCircle size={32} />
                                <p>No deep analysis findings match the current filters.</p>
                            </div>
                        )}
                    </div>
                </>
            )}
        </div>
    );
};

const FindingCard: React.FC<{
    finding: DeepFinding;
    expanded: boolean;
    onToggle: () => void;
}> = ({ finding, expanded, onToggle }) => {
    const sevColor = SEVERITY_COLORS[finding.severity || 'info'];
    const categoryLabel = CATEGORY_LABELS[finding.category || ''] || finding.category || 'Unknown';

    return (
        <div className={`finding-card severity-${finding.severity || 'info'}`}>
            <button className="finding-header" onClick={onToggle}>
                <div className="finding-left">
                    <span className="severity-indicator" style={{ backgroundColor: sevColor }} />
                    <span className="finding-title">{finding.title}</span>
                </div>
                <div className="finding-right">
                    <span className="category-tag">{categoryLabel}</span>
                    {finding.verified && (
                        <span className="verified-badge" title="AST-verified">
                            <CheckCircle size={12} /> Verified
                        </span>
                    )}
                    {finding.confidence !== undefined && (
                        <span className="confidence-badge" title={`Confidence: ${(finding.confidence * 100).toFixed(0)}%`}>
                            {(finding.confidence * 100).toFixed(0)}%
                        </span>
                    )}
                    <span className="severity-badge" style={{ color: sevColor }}>
                        {finding.severity || 'info'}
                    </span>
                    {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </div>
            </button>
            {expanded && (
                <div className="finding-body">
                    <p className="finding-details">{finding.details}</p>
                    {finding.hint && (
                        <div className="finding-hint">
                            <Zap size={14} />
                            <span>{finding.hint}</span>
                        </div>
                    )}
                    {finding.files && finding.files.length > 0 && (
                        <div className="finding-files">
                            {finding.files.map((file, i) => (
                                <span key={i} className="file-tag">
                                    <FileCode size={12} />
                                    {file}
                                    {finding.line && `:${finding.line}`}
                                    {finding.endLine && `-${finding.endLine}`}
                                </span>
                            ))}
                        </div>
                    )}
                    <div className="finding-meta">
                        {finding.source && <span className="meta-tag">Source: {finding.source}</span>}
                    </div>
                </div>
            )}
        </div>
    );
};

const ScoreRing: React.FC<{ label: string; score: number }> = ({ label, score }) => {
    const circumference = 2 * Math.PI * 36;
    const offset = circumference - (score / 100) * circumference;
    const color = score >= 80 ? 'var(--status-success)' : score >= 60 ? 'var(--status-warning)' : 'var(--status-error)';

    return (
        <div className="score-ring">
            <svg width="88" height="88" viewBox="0 0 88 88">
                <circle cx="44" cy="44" r="36" fill="none" stroke="var(--border-dim)" strokeWidth="6" />
                <circle
                    cx="44" cy="44" r="36" fill="none" stroke={color} strokeWidth="6"
                    strokeDasharray={circumference} strokeDashoffset={offset}
                    strokeLinecap="round"
                    transform="rotate(-90 44 44)"
                    style={{ transition: 'stroke-dashoffset 0.8s ease' }}
                />
                <text x="44" y="42" textAnchor="middle" fill="var(--text-main)" fontSize="18" fontWeight="700">{score}</text>
                <text x="44" y="56" textAnchor="middle" fill="var(--text-dim)" fontSize="9">/100</text>
            </svg>
            <span className="score-label">{label}</span>
        </div>
    );
};
