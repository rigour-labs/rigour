import React, { useState, useEffect } from 'react';
import { Brain, Search, RefreshCw, Clock, Key, ChevronRight, Database, Copy, Check } from 'lucide-react';

interface MemoryEntry {
    value: string | Record<string, unknown>;
    timestamp: string;
}

const getValueAsString = (value: string | Record<string, unknown>): string => {
    if (typeof value === 'string') return value;
    return JSON.stringify(value, null, 2);
};

interface MemoryStore {
    memories: Record<string, MemoryEntry>;
}

export const MemoryBank: React.FC = () => {
    const [memoryStore, setMemoryStore] = useState<MemoryStore>({ memories: {} });
    const [selectedKey, setSelectedKey] = useState<string | null>(null);
    const [searchQuery, setSearchQuery] = useState('');
    const [isLoading, setIsLoading] = useState(true);
    const [copied, setCopied] = useState(false);

    const fetchMemory = async () => {
        setIsLoading(true);
        try {
            const res = await fetch('/api/memory');
            const data = await res.json();
            // Handle both formats: { memories: {...} } or direct { key: { value, timestamp } }
            if (data.memories) {
                setMemoryStore(data);
            } else {
                setMemoryStore({ memories: data });
            }
        } catch (err) {
            console.error('Failed to fetch memory:', err);
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        fetchMemory();
    }, []);

    const memories = Object.entries(memoryStore.memories || {});
    const filteredMemories = memories.filter(([key]) =>
        key.toLowerCase().includes(searchQuery.toLowerCase())
    );

    const selectedMemory = selectedKey ? memoryStore.memories[selectedKey] : null;

    const formatDate = (timestamp: string) => {
        try {
            return new Date(timestamp).toLocaleString();
        } catch {
            return timestamp;
        }
    };

    const copyToClipboard = () => {
        if (!selectedMemory) return;
        navigator.clipboard.writeText(getValueAsString(selectedMemory.value));
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    const renderValue = (value: string | Record<string, unknown>) => {
        const strValue = getValueAsString(value);
        // Simple heuristic: if it looks like an audit report (has numbered items like 1), 2) etc)
        // or has "Priority:", let's split it into blocks
        if (strValue.includes('1)') && strValue.includes('2)')) {
            const sections = strValue.split(/(\d+\))/);
            return (
                <div className="formatted-content">
                    {sections.map((section, i) => {
                        if (/^\d+\)$/.test(section)) {
                            return <div key={i} className="section-marker">{section}</div>;
                        }
                        if (section.trim().startsWith('Priority:')) {
                            const [p, rest] = section.split('Priority:');
                            return (
                                <React.Fragment key={i}>
                                    {p.trim() && <div className="section-body">{p.trim()}</div>}
                                    <div className="priority-box">{rest.trim()}</div>
                                </React.Fragment>
                            );
                        }
                        return section.trim() ? <div key={i} className="section-body">{section.trim()}</div> : null;
                    })}
                </div>
            );
        }

        // Default: Preserve newlines and wrap
        return <pre>{strValue}</pre>;
    };

    return (
        <div className="memory-bank">
            <div className="memory-header">
                <div className="memory-title">
                    <Brain size={24} />
                    <h2>Memory Bank</h2>
                    <span className="memory-count">{memories.length} entries</span>
                </div>
                <div className="memory-actions">
                    <div className="search-box">
                        <Search size={16} />
                        <input
                            type="text"
                            placeholder="Search memories..."
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                        />
                    </div>
                    <button className="refresh-btn" onClick={fetchMemory} disabled={isLoading}>
                        <RefreshCw size={16} className={isLoading ? 'spinning' : ''} />
                    </button>
                </div>
            </div>

            <div className="memory-content">
                <div className="memory-list">
                    {isLoading ? (
                        <div className="memory-loading">Loading memories...</div>
                    ) : filteredMemories.length === 0 ? (
                        <div className="memory-empty">
                            <Database size={48} />
                            <h3>No Memories Stored</h3>
                            <p>Use <code>store_memory</code> via MCP to persist agent context.</p>
                        </div>
                    ) : (
                        filteredMemories.map(([key, entry]) => (
                            <div
                                key={key}
                                className={`memory-item ${selectedKey === key ? 'active' : ''}`}
                                onClick={() => setSelectedKey(key)}
                            >
                                <div className="memory-item-header">
                                    <Key size={14} />
                                    <span className="memory-key">{key}</span>
                                    <ChevronRight size={14} className="chevron" />
                                </div>
                                <div className="memory-item-meta">
                                    <Clock size={12} />
                                    <span>{formatDate(entry.timestamp)}</span>
                                </div>
                                <div className="memory-item-preview">
                                    {(() => {
                                        const str = getValueAsString(entry.value);
                                        return str.slice(0, 100) + (str.length > 100 ? '...' : '');
                                    })()}
                                </div>
                            </div>
                        ))
                    )}
                </div>

                <div className="memory-detail">
                    {selectedMemory ? (
                        <>
                            <div className="detail-header">
                                <Key size={18} />
                                <h3>{selectedKey}</h3>
                            </div>
                            <div className="detail-meta">
                                <div className="meta-left">
                                    <Clock size={14} />
                                    <span>Stored: {formatDate(selectedMemory.timestamp)}</span>
                                </div>
                                <button className={`copy-btn ${copied ? 'copied' : ''}`} onClick={copyToClipboard}>
                                    {copied ? <Check size={14} /> : <Copy size={14} />}
                                    <span>{copied ? 'Copied' : 'Copy'}</span>
                                </button>
                            </div>
                            <div className="detail-content">
                                {renderValue(selectedMemory.value)}
                            </div>
                        </>
                    ) : (
                        <div className="detail-placeholder">
                            <Brain size={48} />
                            <p>Select a memory to view its contents</p>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};
