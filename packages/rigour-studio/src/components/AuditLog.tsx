import React, { useState, useEffect } from 'react';
import { Activity, Search, Filter, Clock, CheckCircle, XCircle, AlertTriangle, ChevronRight, Terminal, FileCode, Trash2, Download, RefreshCw, Eye, X } from 'lucide-react';

export interface LogEntry {
    id: string;
    requestId?: string;
    timestamp: string;
    tool: string;
    arguments?: Record<string, any>;
    status?: 'success' | 'error' | 'pending';
    error?: string;
    _rigour_report?: any;
    arbitrated?: boolean;
    decision?: 'approve' | 'reject';
    type?: string;
    command?: string;
}

interface AuditLogProps {
    logs: LogEntry[];
    onClearLogs: () => void;
    onSelectLog: (log: LogEntry | null) => void;
    selectedLog: LogEntry | null;
}

export const AuditLog: React.FC<AuditLogProps> = ({ logs, onClearLogs, onSelectLog, selectedLog }) => {
    const [searchQuery, setSearchQuery] = useState('');
    const [statusFilter, setStatusFilter] = useState<string>('all');
    const [toolFilter, setToolFilter] = useState<string>('all');

    // Group logs by requestId
    const groupedLogs = React.useMemo(() => {
        const groups: Record<string, LogEntry> = {};
        logs.forEach(log => {
            const rid = log.requestId || log.id;
            if (!groups[rid]) groups[rid] = { ...log };
            else groups[rid] = { ...groups[rid], ...log };
        });
        return Object.values(groups).sort((a, b) =>
            new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
        );
    }, [logs]);

    // Get unique tools for filter
    const uniqueTools = React.useMemo(() => {
        const tools = new Set<string>();
        groupedLogs.forEach(log => log.tool && tools.add(log.tool));
        return Array.from(tools);
    }, [groupedLogs]);

    // Filter logs
    const filteredLogs = React.useMemo(() => {
        return groupedLogs.filter(log => {
            const matchesSearch = !searchQuery ||
                log.tool?.toLowerCase().includes(searchQuery.toLowerCase()) ||
                JSON.stringify(log.arguments || {}).toLowerCase().includes(searchQuery.toLowerCase());
            const matchesStatus = statusFilter === 'all' || log.status === statusFilter;
            const matchesTool = toolFilter === 'all' || log.tool === toolFilter;
            return matchesSearch && matchesStatus && matchesTool;
        });
    }, [groupedLogs, searchQuery, statusFilter, toolFilter]);

    // Stats
    const stats = React.useMemo(() => ({
        total: groupedLogs.length,
        success: groupedLogs.filter(l => l.status === 'success').length,
        error: groupedLogs.filter(l => l.status === 'error').length,
        pending: groupedLogs.filter(l => !l.status || l.status === 'pending').length,
    }), [groupedLogs]);

    const exportLogs = () => {
        const data = JSON.stringify(filteredLogs, null, 2);
        const blob = new Blob([data], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `rigour-audit-${new Date().toISOString().split('T')[0]}.json`;
        a.click();
    };

    return (
        <div className="audit-log">
            <div className="audit-header">
                <div className="audit-title">
                    <Activity size={24} />
                    <h2>Audit Trail</h2>
                    <span className="log-count">{filteredLogs.length} events</span>
                </div>
                <div className="audit-actions">
                    <button className="btn-secondary" onClick={onClearLogs}>
                        <Trash2 size={16} /> Clear
                    </button>
                    <button className="btn-primary" onClick={exportLogs}>
                        <Download size={16} /> Export
                    </button>
                </div>
            </div>

            <div className="audit-stats">
                <div className="stat-pill">
                    <Activity size={14} />
                    <span>{stats.total} Total</span>
                </div>
                <div className="stat-pill success">
                    <CheckCircle size={14} />
                    <span>{stats.success} Success</span>
                </div>
                <div className="stat-pill error">
                    <XCircle size={14} />
                    <span>{stats.error} Failed</span>
                </div>
                <div className="stat-pill pending">
                    <AlertTriangle size={14} />
                    <span>{stats.pending} Pending</span>
                </div>
            </div>

            <div className="audit-filters">
                <div className="search-box">
                    <Search size={16} />
                    <input
                        type="text"
                        placeholder="Search logs..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                    />
                </div>
                <div className="filter-box">
                    <Filter size={16} />
                    <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                        <option value="all">All Status</option>
                        <option value="success">Success</option>
                        <option value="error">Error</option>
                        <option value="pending">Pending</option>
                    </select>
                </div>
                <div className="filter-box">
                    <Terminal size={16} />
                    <select value={toolFilter} onChange={(e) => setToolFilter(e.target.value)}>
                        <option value="all">All Tools</option>
                        {uniqueTools.map(t => (
                            <option key={t} value={t}>{t}</option>
                        ))}
                    </select>
                </div>
            </div>

            <div className="audit-content">
                <div className="log-list">
                    {filteredLogs.length === 0 ? (
                        <div className="empty-state">
                            <Terminal size={48} />
                            <h3>No Interactions Detected</h3>
                            <p>Rigour tool calls will appear here in real-time.</p>
                        </div>
                    ) : (
                        filteredLogs.map(log => (
                            <div
                                key={log.id}
                                className={`log-entry ${selectedLog?.id === log.id ? 'active' : ''} ${log._rigour_report ? 'has-report' : ''}`}
                                onClick={() => onSelectLog(selectedLog?.id === log.id ? null : log)}
                            >
                                <div className="log-header">
                                    <span className={`status-dot ${log.status || 'pending'}`} />
                                    <span className="log-tool">{log.tool}</span>
                                    <span className="log-time">
                                        <Clock size={12} />
                                        {new Date(log.timestamp).toLocaleTimeString()}
                                    </span>
                                    {log._rigour_report && (
                                        <span className="report-badge">
                                            <Eye size={12} /> Report
                                        </span>
                                    )}
                                    {log.arbitrated && (
                                        <span className={`arbitrated-badge ${log.decision}`}>
                                            {log.decision === 'approve' ? 'Approved' : 'Rejected'}
                                        </span>
                                    )}
                                    <ChevronRight size={14} className="chevron" />
                                </div>
                                {log.requestId && (
                                    <div className="log-request-id">
                                        ID: {log.requestId.slice(0, 12)}...
                                    </div>
                                )}
                            </div>
                        ))
                    )}
                </div>

                <div className="log-detail">
                    {selectedLog ? (
                        <LogDetailView log={selectedLog} onClose={() => onSelectLog(null)} />
                    ) : (
                        <div className="detail-placeholder">
                            <FileCode size={48} />
                            <p>Select a log entry to view details</p>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

const LogDetailView: React.FC<{ log: LogEntry; onClose: () => void }> = ({ log, onClose }) => {
    const hasReport = !!log._rigour_report || ['rigour_checkpoint', 'rigour_agent_register', 'rigour_handoff'].includes(log.tool);
    const [activeTab, setActiveTab] = useState<'args' | 'report'>(hasReport ? 'report' : 'args');

    return (
        <div className="log-detail-view">
            <div className="detail-header">
                <div className="detail-info">
                    <span className={`status-badge ${log.status || 'pending'}`}>
                        {log.status === 'success' ? <CheckCircle size={14} /> :
                            log.status === 'error' ? <XCircle size={14} /> :
                                <AlertTriangle size={14} />}
                        {log.status || 'pending'}
                    </span>
                    <h3>{log.tool}</h3>
                </div>
                <button className="close-btn" onClick={onClose}>
                    <X size={18} />
                </button>
            </div>

            <div className="detail-meta">
                <div className="meta-item">
                    <span className="meta-label">Timestamp</span>
                    <span className="meta-value">{new Date(log.timestamp).toLocaleString()}</span>
                </div>
                {log.requestId && (
                    <div className="meta-item">
                        <span className="meta-label">Request ID</span>
                        <span className="meta-value mono">{log.requestId}</span>
                    </div>
                )}
            </div>

            {hasReport && (
                <div className="detail-tabs">
                    <button
                        className={activeTab === 'report' ? 'active' : ''}
                        onClick={() => setActiveTab('report')}
                    >
                        {log._rigour_report ? 'Verification Report' : 'Visualized Content'}
                    </button>
                    <button
                        className={activeTab === 'args' ? 'active' : ''}
                        onClick={() => setActiveTab('args')}
                    >
                        Technical Arguments
                    </button>
                </div>
            )}

            <div className="detail-body">
                {activeTab === 'args' ? (
                    <>
                        {log.arguments && (
                            <div className="code-section">
                                <h4>Arguments</h4>
                                <pre>{JSON.stringify(log.arguments, null, 2)}</pre>
                            </div>
                        )}
                        {log.error && (
                            <div className="error-section">
                                <h4>Error</h4>
                                <div className="error-message">{log.error}</div>
                            </div>
                        )}
                    </>
                ) : (
                    <div className="verification-view">
                        {log.tool === 'rigour_checkpoint' ? (
                            <div className="checkpoint-viz">
                                <div className="viz-stats">
                                    <div className="viz-stat">
                                        <span className="label">Progress</span>
                                        <span className="value">{log.arguments?.progressPct ?? 0}%</span>
                                    </div>
                                    <div className="viz-stat">
                                        <span className="label">Quality</span>
                                        <span className="value" style={{ color: (log.arguments?.qualityScore ?? 0) >= 80 ? '#34d399' : '#f87171' }}>
                                            {log.arguments?.qualityScore ?? 0}%
                                        </span>
                                    </div>
                                </div>
                                <div className="viz-summary">
                                    <h4>Summary of Work</h4>
                                    <p>{log.arguments?.summary || 'No summary provided.'}</p>
                                </div>
                                {log.arguments?.filesChanged && log.arguments.filesChanged.length > 0 && (
                                    <div className="viz-files">
                                        <h4>Files Changed</h4>
                                        <div className="file-badges">
                                            {log.arguments.filesChanged.map((f: string) => (
                                                <span key={f} className="file-badge">{f}</span>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </div>
                        ) : log.tool === 'rigour_agent_register' ? (
                            <div className="agent-viz">
                                <Activity size={32} className="viz-icon" />
                                <h3>Agent Scope Claims</h3>
                                <div className="scope-box">
                                    <h4>Claimed Scope:</h4>
                                    <div className="scope-list">
                                        {log.arguments?.taskScope?.map((s: string) => (
                                            <code key={s}>{s}</code>
                                        ))}
                                    </div>
                                </div>
                            </div>
                        ) : (
                            <div className="code-section">
                                <h4>Rigour Report</h4>
                                <pre>{JSON.stringify(log._rigour_report, null, 2)}</pre>
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
};
