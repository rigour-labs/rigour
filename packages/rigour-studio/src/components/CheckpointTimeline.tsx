import React from 'react';
import { Flag, TrendingDown, TrendingUp, AlertTriangle, CheckCircle } from 'lucide-react';

interface Checkpoint {
    checkpointId: string;
    agentId: string;
    timestamp: string;
    progressPct: number;
    filesChanged: string[];
    summary: string;
    qualityScore: number;
    warnings: string[];
}

interface Props {
    checkpoints: Checkpoint[];
}

export function CheckpointTimeline({ checkpoints }: Props) {
    if (!checkpoints || checkpoints.length === 0) {
        return (
            <div className="empty-state">
                <Flag size={48} />
                <h3>No Checkpoints Yet</h3>
                <p>Checkpoints will appear here as agents report progress via <code>rigour_checkpoint</code>.</p>
                <div className="hint-box">
                    <span>Default interval: 15 minutes</span>
                </div>
            </div>
        );
    }

    const getScoreColor = (score: number) => {
        if (score >= 80) return '#34d399';
        if (score >= 60) return '#fbbf24';
        return '#f87171';
    };

    const getTrend = (idx: number) => {
        if (idx === 0) return null;
        const prev = checkpoints[idx - 1].qualityScore;
        const curr = checkpoints[idx].qualityScore;
        if (curr > prev + 5) return <TrendingUp size={14} color="#34d399" />;
        if (curr < prev - 5) return <TrendingDown size={14} color="#f87171" />;
        return null;
    };

    const hasDrift = checkpoints.some((cp, idx) => {
        if (idx < 2) return false;
        const recent = checkpoints.slice(Math.max(0, idx - 2), idx);
        const avgPrev = recent.reduce((sum, c) => sum + c.qualityScore, 0) / recent.length;
        return cp.qualityScore < avgPrev - 10;
    });

    return (
        <div className="checkpoint-timeline">
            <div className="panel-header">
                <div className="title">
                    <Flag size={18} />
                    <span>Checkpoint Timeline</span>
                </div>
                <div className="drift-visualization">
                    <svg width="120" height="30" viewBox="0 0 120 30" className="drift-sparkline">
                        <path
                            d={`M ${checkpoints.map((cp, i) => `${(i / (checkpoints.length - 1 || 1)) * 120} ${30 - (cp.qualityScore / 100) * 30}`).join(' L ')}`}
                            fill="none"
                            stroke="var(--accent-primary)"
                            strokeWidth="2"
                            strokeLinecap="round"
                        />
                        {checkpoints.map((cp, i) => (
                            <circle
                                key={i}
                                cx={(i / (checkpoints.length - 1 || 1)) * 120}
                                cy={30 - (cp.qualityScore / 100) * 30}
                                r="2"
                                fill={getScoreColor(cp.qualityScore)}
                            />
                        ))}
                    </svg>
                    <span className="drift-label">Session Stability</span>
                </div>
                {hasDrift && (
                    <div className="drift-alert">
                        <AlertTriangle size={14} />
                        <span>Drift Detected</span>
                    </div>
                )}
            </div>

            <div className="timeline-container">
                <div className="timeline-line" />

                {checkpoints.map((cp, idx) => (
                    <div key={cp.checkpointId} className={`checkpoint-entry ${cp.warnings.length > 0 ? 'has-warnings' : ''}`}>
                        <div className="checkpoint-marker">
                            <div
                                className="marker-dot"
                                style={{ backgroundColor: getScoreColor(cp.qualityScore) }}
                            />
                        </div>

                        <div className="checkpoint-content">
                            <div className="checkpoint-header">
                                <span className="checkpoint-id">{cp.checkpointId}</span>
                                <span className="checkpoint-time">
                                    {new Date(cp.timestamp).toLocaleTimeString()}
                                </span>
                            </div>

                            <div className="checkpoint-stats">
                                <div className="stat">
                                    <span className="label">Progress</span>
                                    <div className="progress-bar">
                                        <div className="progress-fill" style={{ width: `${cp.progressPct}%` }} />
                                    </div>
                                    <span className="value">{cp.progressPct}%</span>
                                </div>

                                <div className="stat">
                                    <span className="label">Quality</span>
                                    <span
                                        className="value score"
                                        style={{ color: getScoreColor(cp.qualityScore) }}
                                    >
                                        {cp.qualityScore}%
                                        {getTrend(idx)}
                                    </span>
                                </div>

                                <div className="stat">
                                    <span className="label">Agent</span>
                                    <span className="value agent-id">{cp.agentId}</span>
                                </div>
                            </div>

                            <div className="checkpoint-summary">
                                <p>{cp.summary}</p>
                            </div>

                            {cp.filesChanged.length > 0 && (
                                <div className="files-changed">
                                    <span className="count">{cp.filesChanged.length} files changed</span>
                                </div>
                            )}

                            {cp.warnings.length > 0 && (
                                <div className="warnings">
                                    {cp.warnings.map((warning, wIdx) => (
                                        <div key={wIdx} className="warning-item">
                                            <AlertTriangle size={12} />
                                            <span>{warning}</span>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}
