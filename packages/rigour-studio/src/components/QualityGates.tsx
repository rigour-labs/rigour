import React, { useState, useEffect } from 'react';
import { Shield, RefreshCw, FileCode, AlertTriangle, CheckCircle, XCircle, Settings, Layers, Lock, Zap, GitBranch } from 'lucide-react';

interface GateConfig {
    max_file_lines?: number;
    forbid_todos?: boolean;
    forbid_fixme?: boolean;
    forbid_paths?: string[];
    required_files?: string[];
    ast?: {
        complexity?: number;
        max_methods?: number;
        max_params?: number;
        max_nesting?: number;
        max_inheritance_depth?: number;
        max_class_dependencies?: number;
        max_function_lines?: number;
    };
    dependencies?: {
        forbid?: string[];
    };
    architecture?: {
        boundaries?: Array<{ from: string; to: string; mode: 'allow' | 'deny' }>;
    };
    safety?: {
        max_files_changed_per_cycle?: number;
        protected_paths?: string[];
    };
    context?: {
        enabled?: boolean;
        sensitivity?: number;
        mining_depth?: number;
    };
    retry_loop_breaker?: {
        enabled?: boolean;
        max_retries?: number;
    };
}

interface RigourConfig {
    version?: number;
    preset?: string;
    gates?: GateConfig;
    output?: { report_path?: string };
    planned?: string[];
    ignore?: string[];
}

export const QualityGates: React.FC = () => {
    const [config, setConfig] = useState<RigourConfig | null>(null);
    const [rawYaml, setRawYaml] = useState<string>('');
    const [isLoading, setIsLoading] = useState(true);
    const [viewMode, setViewMode] = useState<'visual' | 'raw'>('visual');

    const fetchConfig = async () => {
        setIsLoading(true);
        try {
            const res = await fetch('/api/config');
            const text = await res.text();
            setRawYaml(text);
            // Parse YAML to JSON for visualization
            const parsed = parseYaml(text);
            setConfig(parsed);
        } catch (err) {
            console.error('Failed to fetch config:', err);
        } finally {
            setIsLoading(false);
        }
    };

    // Simple YAML parser for display purposes
    const parseYaml = (yaml: string): RigourConfig => {
        try {
            const lines = yaml.split('\n');
            const result: any = {};
            let currentSection: string | null = null;
            let currentSubSection: string | null = null;

            for (const line of lines) {
                if (line.startsWith('#') || !line.trim()) continue;

                const indent = line.search(/\S/);
                const content = line.trim();

                if (indent === 0 && content.includes(':')) {
                    const [key] = content.split(':');
                    currentSection = key.trim();
                    currentSubSection = null;
                    const value = content.split(':')[1]?.trim();
                    if (value && value !== '{}' && value !== '[]') {
                        result[currentSection] = isNaN(Number(value)) ? value : Number(value);
                    } else {
                        result[currentSection] = {};
                    }
                } else if (indent === 2 && currentSection && content.includes(':')) {
                    const [key] = content.split(':');
                    currentSubSection = key.trim();
                    const value = content.split(':').slice(1).join(':').trim();
                    if (value && value !== '{}' && value !== '[]') {
                        if (typeof result[currentSection] !== 'object') result[currentSection] = {};
                        const parsed = value === 'true' ? true : value === 'false' ? false : isNaN(Number(value)) ? value : Number(value);
                        result[currentSection][currentSubSection] = parsed;
                    } else {
                        if (typeof result[currentSection] !== 'object') result[currentSection] = {};
                        result[currentSection][currentSubSection] = {};
                    }
                } else if (indent === 4 && currentSection && currentSubSection && content.includes(':')) {
                    const [key] = content.split(':');
                    const value = content.split(':').slice(1).join(':').trim();
                    if (typeof result[currentSection][currentSubSection] !== 'object') {
                        result[currentSection][currentSubSection] = {};
                    }
                    const parsed = value === 'true' ? true : value === 'false' ? false : isNaN(Number(value)) ? value : Number(value);
                    result[currentSection][currentSubSection][key.trim()] = parsed;
                }
            }
            return result;
        } catch {
            return {};
        }
    };

    useEffect(() => {
        fetchConfig();
    }, []);

    const gates = config?.gates || {};

    return (
        <div className="quality-gates">
            <div className="gates-header">
                <div className="gates-title">
                    <Shield size={24} />
                    <h2>Quality Gates</h2>
                    {config?.preset && <span className="preset-badge">{config.preset}</span>}
                </div>
                <div className="gates-actions">
                    <div className="view-toggle">
                        <button
                            className={viewMode === 'visual' ? 'active' : ''}
                            onClick={() => setViewMode('visual')}
                        >
                            <Layers size={16} /> Visual
                        </button>
                        <button
                            className={viewMode === 'raw' ? 'active' : ''}
                            onClick={() => setViewMode('raw')}
                        >
                            <FileCode size={16} /> YAML
                        </button>
                    </div>
                    <button className="refresh-btn" onClick={fetchConfig} disabled={isLoading}>
                        <RefreshCw size={16} className={isLoading ? 'spinning' : ''} />
                    </button>
                </div>
            </div>

            {isLoading ? (
                <div className="gates-loading">Loading configuration...</div>
            ) : viewMode === 'raw' ? (
                <div className="gates-raw">
                    <pre>{rawYaml}</pre>
                </div>
            ) : (
                <div className="gates-content">
                    {/* Code Quality Section */}
                    <div className="gate-section">
                        <div className="section-header">
                            <FileCode size={18} />
                            <h3>Code Quality</h3>
                        </div>
                        <div className="gate-grid">
                            <GateCard label="Max File Lines" value={gates.max_file_lines} icon={<FileCode size={16} />} />
                            <GateCard label="Forbid TODOs" value={gates.forbid_todos} icon={gates.forbid_todos ? <XCircle size={16} /> : <CheckCircle size={16} />} />
                            <GateCard label="Forbid FIXMEs" value={gates.forbid_fixme} icon={gates.forbid_fixme ? <XCircle size={16} /> : <CheckCircle size={16} />} />
                        </div>
                    </div>

                    {/* AST Limits Section */}
                    {gates.ast && (
                        <div className="gate-section">
                            <div className="section-header">
                                <GitBranch size={18} />
                                <h3>AST Limits</h3>
                            </div>
                            <div className="gate-grid">
                                <GateCard label="Complexity" value={gates.ast.complexity} />
                                <GateCard label="Max Methods" value={gates.ast.max_methods} />
                                <GateCard label="Max Params" value={gates.ast.max_params} />
                                <GateCard label="Max Nesting" value={gates.ast.max_nesting} />
                                <GateCard label="Max Function Lines" value={gates.ast.max_function_lines} />
                                <GateCard label="Max Inheritance" value={gates.ast.max_inheritance_depth} />
                            </div>
                        </div>
                    )}

                    {/* File Guard Section */}
                    {gates.safety && (
                        <div className="gate-section">
                            <div className="section-header">
                                <Lock size={18} />
                                <h3>File Guard</h3>
                            </div>
                            <div className="gate-grid">
                                <GateCard label="Max Files/Cycle" value={gates.safety.max_files_changed_per_cycle} />
                            </div>
                            {gates.safety.protected_paths && gates.safety.protected_paths.length > 0 && (
                                <div className="protected-paths">
                                    <h4>Protected Paths</h4>
                                    <div className="path-list">
                                        {gates.safety.protected_paths.map((p, i) => (
                                            <span key={i} className="path-tag">{p}</span>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>
                    )}

                    {/* Required Files Section */}
                    {gates.required_files && gates.required_files.length > 0 && (
                        <div className="gate-section">
                            <div className="section-header">
                                <AlertTriangle size={18} />
                                <h3>Required Files</h3>
                            </div>
                            <div className="file-list">
                                {gates.required_files.map((f, i) => (
                                    <div key={i} className="file-item">
                                        <FileCode size={14} />
                                        <span>{f}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Context Mining */}
                    {gates.context && (
                        <div className="gate-section">
                            <div className="section-header">
                                <Zap size={18} />
                                <h3>Context Mining</h3>
                            </div>
                            <div className="gate-grid">
                                <GateCard label="Enabled" value={gates.context.enabled} />
                                <GateCard label="Sensitivity" value={gates.context.sensitivity} />
                                <GateCard label="Mining Depth" value={gates.context.mining_depth} />
                            </div>
                        </div>
                    )}

                    {/* Retry Loop Breaker */}
                    {gates.retry_loop_breaker && (
                        <div className="gate-section">
                            <div className="section-header">
                                <Settings size={18} />
                                <h3>Retry Loop Breaker</h3>
                            </div>
                            <div className="gate-grid">
                                <GateCard label="Enabled" value={gates.retry_loop_breaker.enabled} />
                                <GateCard label="Max Retries" value={gates.retry_loop_breaker.max_retries} />
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

const GateCard: React.FC<{ label: string; value: any; icon?: React.ReactNode }> = ({ label, value, icon }) => {
    const displayValue = typeof value === 'boolean'
        ? (value ? 'Yes' : 'No')
        : value ?? 'N/A';

    return (
        <div className="gate-card">
            {icon && <div className="gate-icon">{icon}</div>}
            <div className="gate-info">
                <span className="gate-value">{displayValue}</span>
                <span className="gate-label">{label}</span>
            </div>
        </div>
    );
};
