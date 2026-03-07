import React, { useState, useEffect } from 'react';
import {
    TrendingDown,
    TrendingUp,
    Minus,
    AlertTriangle,
    Activity,
    RefreshCw,
    BarChart3,
    Zap,
    Shield,
    Brain,
    Clock,
    ChevronDown,
    ChevronRight
} from 'lucide-react';

// ─── Types (mirrors temporal-drift.ts) ──────────────────────────────

type DriftDirection = 'improving' | 'stable' | 'degrading';

interface TrendPoint {
    timestamp: number;
    value: number;
    ewma: number;
}

interface ProvenanceStream {
    direction: DriftDirection;
    zScore: number;
    series: TrendPoint[];
    currentEWMA: number;
    historicalAvg: number;
}

interface MonthlyBucket {
    month: string;
    avgScore: number;
    avgAiHealth: number;
    avgStructural: number;
    scanCount: number;
    totalFailures: number;
    provenanceBreakdown: {
        aiDrift: number;
        structural: number;
        security: number;
    };
}

interface WeeklyBucket {
    weekStart: string;
    avgScore: number;
    avgAiHealth: number;
    scanCount: number;
}

interface TemporalDriftReport {
    repo: string;
    totalScans: number;
    timeSpanDays: number;
    overallDirection: DriftDirection;
    overallZScore: number;
    streams: {
        aiDrift: ProvenanceStream;
        structural: ProvenanceStream;
        security: ProvenanceStream;
        overall: ProvenanceStream;
    };
    monthly: MonthlyBucket[];
    weekly: WeeklyBucket[];
    latestScanAnomaly: {
        isAnomaly: boolean;
        direction: 'spike' | 'dip' | 'normal';
        zScore: number;
        message: string;
    };
    narrative: string;
}

// ─── Helpers ────────────────────────────────────────────────────────

const DIRECTION_CONFIG: Record<DriftDirection, { color: string; icon: typeof TrendingUp; label: string }> = {
    improving: { color: '#34d399', icon: TrendingUp, label: 'Improving' },
    stable: { color: 'var(--accent-primary)', icon: Minus, label: 'Stable' },
    degrading: { color: '#f87171', icon: TrendingDown, label: 'Degrading' },
};

function DirectionBadge({ direction, zScore }: { direction: DriftDirection; zScore?: number }) {
    const config = DIRECTION_CONFIG[direction];
    const Icon = config.icon;
    return (
        <span className="direction-badge" style={{ color: config.color, borderColor: config.color }}>
            <Icon size={14} />
            <span>{config.label}</span>
            {zScore !== undefined && <span className="z-score">Z={zScore.toFixed(1)}</span>}
        </span>
    );
}

function ScoreRing({ score, label, size = 80 }: { score: number; label: string; size?: number }) {
    const radius = (size - 8) / 2;
    const circumference = 2 * Math.PI * radius;
    const progress = (score / 100) * circumference;
    const color = score >= 80 ? '#34d399' : score >= 60 ? '#fbbf24' : '#f87171';

    return (
        <div className="score-ring" style={{ width: size, height: size + 20 }}>
            <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
                <circle
                    cx={size / 2} cy={size / 2} r={radius}
                    fill="none" stroke="var(--bg-tertiary)" strokeWidth="6"
                />
                <circle
                    cx={size / 2} cy={size / 2} r={radius}
                    fill="none" stroke={color} strokeWidth="6"
                    strokeDasharray={`${progress} ${circumference - progress}`}
                    strokeDashoffset={circumference / 4}
                    strokeLinecap="round"
                    style={{ transition: 'stroke-dasharray 0.8s ease' }}
                />
                <text x={size / 2} y={size / 2} textAnchor="middle" dominantBaseline="central"
                    fill="var(--text-primary)" fontSize="16" fontWeight="bold">
                    {Math.round(score)}
                </text>
            </svg>
            <span className="ring-label">{label}</span>
        </div>
    );
}

function EWMASparkline({ series, direction }: { series: TrendPoint[]; direction: DriftDirection }) {
    if (series.length < 2) return null;

    const width = 200;
    const height = 50;
    const padding = 4;

    const ewmaValues = series.map(p => p.ewma);
    const min = Math.min(...ewmaValues) - 5;
    const max = Math.max(...ewmaValues) + 5;
    const range = max - min || 1;

    const points = series.map((p, i) => {
        const x = padding + (i / (series.length - 1)) * (width - 2 * padding);
        const y = height - padding - ((p.ewma - min) / range) * (height - 2 * padding);
        return `${x},${y}`;
    });

    const color = DIRECTION_CONFIG[direction].color;

    // Area fill
    const firstX = padding;
    const lastX = padding + ((series.length - 1) / (series.length - 1)) * (width - 2 * padding);
    const areaPath = `M ${points[0]} L ${points.join(' L ')} L ${lastX},${height} L ${firstX},${height} Z`;

    return (
        <svg width={width} height={height} className="ewma-sparkline">
            <defs>
                <linearGradient id={`grad-${direction}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={color} stopOpacity="0.3" />
                    <stop offset="100%" stopColor={color} stopOpacity="0.02" />
                </linearGradient>
            </defs>
            <path d={areaPath} fill={`url(#grad-${direction})`} />
            <polyline
                points={points.join(' ')}
                fill="none"
                stroke={color}
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
            {/* Current point */}
            <circle
                cx={parseFloat(points[points.length - 1].split(',')[0])}
                cy={parseFloat(points[points.length - 1].split(',')[1])}
                r="3" fill={color}
            />
        </svg>
    );
}

// ─── Stream Card ────────────────────────────────────────────────────

function StreamCard({ name, icon: Icon, stream }: {
    name: string;
    icon: typeof Brain;
    stream: ProvenanceStream;
}) {
    return (
        <div className="stream-card">
            <div className="stream-header">
                <div className="stream-name">
                    <Icon size={16} />
                    <span>{name}</span>
                </div>
                <DirectionBadge direction={stream.direction} zScore={stream.zScore} />
            </div>
            <div className="stream-body">
                <EWMASparkline series={stream.series} direction={stream.direction} />
                <div className="stream-stats">
                    <div className="stat">
                        <span className="stat-label">Current EWMA</span>
                        <span className="stat-value">{stream.currentEWMA.toFixed(1)}</span>
                    </div>
                    <div className="stat">
                        <span className="stat-label">Historical Avg</span>
                        <span className="stat-value">{stream.historicalAvg.toFixed(1)}</span>
                    </div>
                </div>
            </div>
        </div>
    );
}

// ─── Monthly Trend Table ────────────────────────────────────────────

function MonthlyTable({ monthly }: { monthly: MonthlyBucket[] }) {
    const [expanded, setExpanded] = useState(true);

    if (monthly.length === 0) return null;

    return (
        <div className="monthly-section">
            <button className="section-toggle" onClick={() => setExpanded(!expanded)}>
                {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                <BarChart3 size={16} />
                <span>Monthly Breakdown</span>
            </button>
            {expanded && (
                <table className="monthly-table">
                    <thead>
                        <tr>
                            <th>Month</th>
                            <th>Score</th>
                            <th>AI Health</th>
                            <th>Structural</th>
                            <th>Scans</th>
                            <th>AI Drift</th>
                            <th>Security</th>
                        </tr>
                    </thead>
                    <tbody>
                        {monthly.slice().reverse().map(m => {
                            const scoreColor = m.avgScore >= 80 ? '#34d399' : m.avgScore >= 60 ? '#fbbf24' : '#f87171';
                            return (
                                <tr key={m.month}>
                                    <td className="month-cell">{m.month}</td>
                                    <td style={{ color: scoreColor, fontWeight: 600 }}>{m.avgScore.toFixed(0)}</td>
                                    <td>{m.avgAiHealth.toFixed(0)}</td>
                                    <td>{m.avgStructural.toFixed(0)}</td>
                                    <td className="dim">{m.scanCount}</td>
                                    <td className="dim">{m.provenanceBreakdown.aiDrift}</td>
                                    <td className="dim">{m.provenanceBreakdown.security}</td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            )}
        </div>
    );
}

// ─── Main Component ─────────────────────────────────────────────────

export function TemporalDrift() {
    const [report, setReport] = useState<TemporalDriftReport | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const fetchDrift = async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await fetch('/api/drift');
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            if (data && data.totalScans > 0) {
                setReport(data);
            } else {
                setReport(null);
            }
        } catch (e: any) {
            setError(e.message);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => { fetchDrift(); }, []);

    if (loading) {
        return (
            <div className="empty-state">
                <RefreshCw size={48} className="spin" />
                <h3>Analyzing Temporal Drift...</h3>
                <p>Reading scan history from SQLite brain.</p>
            </div>
        );
    }

    if (error) {
        return (
            <div className="empty-state">
                <AlertTriangle size={48} />
                <h3>Drift Analysis Unavailable</h3>
                <p>{error}</p>
                <button className="retry-btn" onClick={fetchDrift}>Retry</button>
            </div>
        );
    }

    if (!report) {
        return (
            <div className="empty-state">
                <Activity size={48} />
                <h3>Not Enough Data</h3>
                <p>Run at least 3 scans with <code>rigour check</code> to see temporal drift analysis.</p>
                <div className="hint-box">
                    <span>Drift detection uses EWMA + Z-score anomaly detection across per-provenance streams.</span>
                </div>
            </div>
        );
    }

    return (
        <div className="temporal-drift">
            {/* Header */}
            <div className="panel-header">
                <div className="title">
                    <Activity size={18} />
                    <span>Temporal Drift Engine</span>
                    <span className="badge">v5 EWMA</span>
                </div>
                <button className="refresh-btn" onClick={fetchDrift} title="Refresh">
                    <RefreshCw size={16} />
                </button>
            </div>

            {/* Overview Banner */}
            <div className={`drift-banner drift-${report.overallDirection}`}>
                <div className="banner-main">
                    <DirectionBadge direction={report.overallDirection} zScore={report.overallZScore} />
                    <span className="banner-repo">{report.repo}</span>
                    <span className="banner-meta">
                        {report.totalScans} scans over {report.timeSpanDays} days
                    </span>
                </div>
                {report.latestScanAnomaly.isAnomaly && (
                    <div className="anomaly-alert">
                        <AlertTriangle size={14} />
                        <span>{report.latestScanAnomaly.message}</span>
                    </div>
                )}
            </div>

            {/* Score Rings Row */}
            <div className="score-rings-row">
                <ScoreRing score={report.streams.overall.currentEWMA} label="Overall" />
                <ScoreRing score={report.streams.aiDrift.currentEWMA} label="AI Health" />
                <ScoreRing score={report.streams.structural.currentEWMA} label="Structural" />
                <ScoreRing score={report.streams.security.currentEWMA} label="Security" />
            </div>

            {/* Per-Provenance Stream Cards */}
            <div className="streams-grid">
                <StreamCard name="AI Drift" icon={Brain} stream={report.streams.aiDrift} />
                <StreamCard name="Structural" icon={Zap} stream={report.streams.structural} />
                <StreamCard name="Security" icon={Shield} stream={report.streams.security} />
                <StreamCard name="Overall" icon={Activity} stream={report.streams.overall} />
            </div>

            {/* Monthly Breakdown */}
            <MonthlyTable monthly={report.monthly} />

            {/* Narrative */}
            <div className="narrative-section">
                <div className="narrative-header">
                    <Clock size={16} />
                    <span>Analysis Narrative</span>
                </div>
                <pre className="narrative-text">{report.narrative}</pre>
            </div>
        </div>
    );
}
