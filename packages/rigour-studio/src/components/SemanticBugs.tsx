import React, { useEffect, useState } from 'react';
import { Crosshair, GitCommit } from 'lucide-react';

/** Mirrors StudioLearnedRule in rigour-cli/src/commands/studio-learned-rules.ts. */
export interface LearnedRule {
    id: string;
    template: 'require-option' | 'require-guard';
    requirement: string;
    appliesTo: string;
    message: string;
    severity: string;
    source: { commit?: string; file: string; function: string };
    validation: { firesBefore: number; firesAfter: number; maxHits: number; repoHits: string[] };
}

const BUILT_IN_RULES = ['credential-redirect', 'in-memory-aggregation', 'degraded-response-cached'];

/** The semantic-bugs gate: built-in proven rules plus rules learned from fixes (`rigour learn`). */
export const SemanticBugs: React.FC<{ enabled: boolean; rules?: string[] | string }> = ({ enabled, rules }) => {
    const [learned, setLearned] = useState<LearnedRule[] | null>(null);

    useEffect(() => {
        fetch('/api/learned-rules')
            .then(res => (res.ok ? res.json() : []))
            .then(setLearned)
            .catch(() => setLearned([]));
    }, []);

    const wanted = ruleList(rules);
    const builtIn = wanted.length ? BUILT_IN_RULES.filter(r => wanted.includes(r)) : BUILT_IN_RULES;

    return (
        <div className="gate-section">
            <div className="section-header">
                <Crosshair size={18} />
                <h3>Semantic Bugs</h3>
            </div>
            <div className="gate-grid">
                <SemanticCard label="Enabled" value={enabled ? 'Yes' : 'No'} />
                <SemanticCard label="Built-in rules" value={builtIn.length} />
                <SemanticCard label="Learned rules" value={learned === null ? '…' : learned.length} />
            </div>
            <div className="protected-paths">
                <h4>Built-in rules</h4>
                <div className="path-list">
                    {builtIn.map(rule => <span key={rule} className="path-tag">{rule}</span>)}
                </div>
            </div>
            {learned && learned.length > 0 && (
                <div className="learned-rules">
                    <h4>Learned from fixes</h4>
                    {learned.map(rule => <LearnedRuleRow key={rule.id} rule={rule} />)}
                </div>
            )}
            {learned && learned.length === 0 && (
                <p className="learned-rules-empty">
                    No learned rules yet. Run <code>rigour learn &lt;fix-commit&gt;</code> to turn a fix into a rule.
                </p>
            )}
        </div>
    );
};

export const LearnedRuleRow: React.FC<{ rule: LearnedRule }> = ({ rule }) => {
    const { validation, source } = rule;
    return (
        <div className="learned-rule">
            <div className="learned-rule-head">
                <span className="learned-rule-id">{rule.id}</span>
                <span className="meta-tag">{rule.severity}</span>
            </div>
            <div className="learned-rule-body">Requires {withCode(rule.requirement)} · applies to {rule.appliesTo}</div>
            <div className="learned-rule-meta">
                <GitCommit size={12} />
                <span>{source.commit ? source.commit.slice(0, 8) : 'before/after files'} · {source.file} ({source.function})</span>
                <span>fires {validation.firesBefore}× before the fix, {validation.firesAfter}× after · {validation.repoHits.length} other hit(s), max {validation.maxHits}</span>
            </div>
        </div>
    );
};

/** Text with `backticked` segments rendered as code. */
function withCode(text: string): React.ReactNode[] {
    return text.split('`').map((part, i) => (i % 2 === 1 ? <code key={i}>{part}</code> : part));
}

/** `rules` as an array, or the flow-style string (`[a, b]`) the display parser leaves it as. */
export function ruleList(rules: string[] | string | undefined): string[] {
    if (Array.isArray(rules)) return rules;
    if (typeof rules !== 'string') return [];
    return rules.replace(/^\[|\]$/g, '').split(',').map(r => r.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}

const SemanticCard: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
    <div className="gate-card">
        <div className="gate-info">
            <span className="gate-value">{value}</span>
            <span className="gate-label">{label}</span>
        </div>
    </div>
);

/** The semantic-bugs gate is on by default: only an explicit `enabled: false` under it turns it off. */
export function semanticBugsEnabledIn(yaml: string | null | undefined): boolean {
    return !/^\s*semantic_bugs:\s*\n(?:\s+#.*\n)*\s+enabled:\s*false\b/m.test(yaml ?? '');
}
