/** /api/governance, as the Governance page reads it (packages/rigour-cli/src/commands/studio-governance.ts). */
export type Stage = 'brief' | 'edit' | 'stop' | 'push' | 'pr';
export type Configured = 'on' | 'off' | 'broken' | 'not checked' | 'no hooks';

export interface CoverageCell { configured: Configured | null; seen: string | null }
export interface CoverageRow { agent: string; cells: Record<Stage, CoverageCell>; note?: string }
export interface Coverage { stages: Stage[]; rows: CoverageRow[]; unattributed: Record<Stage, string | null>; covered: number; possible: number }

export interface Decision { at: string; who: string | null; kind: string; text: string; reason: string | null; pr?: number; source: string }

interface GateRule { name: string; setting: string; blocks: boolean | null; note?: string }
export interface QualityGates {
    configFile: string | null;
    reportOnly: { on: boolean; setBy: 'team' | 'this clone' | null };
    rules: GateRule[];
    commands: Array<{ name: string; command: string }>;
    score: Array<{ at: string; score: number; status: string }>;
    pushes: { passed: number; held: number } | null;
}

export interface JudgeUsage { reviewer: string; model: string | null; version: string | null; reviews: number; costUsd: number | null; pricedReviews: number; tokens: { input: number; output: number } | null }
export interface ReviewerUsage {
    days: Array<{ day: string; runs: number; usd: number | null }>;
    runs: number;
    judges: JudgeUsage[];
    deep: { runs: number; costUsd: number | null; unpricedRuns: number; inputTokens: number; outputTokens: number; models: string[] } | null;
    caps: { runsPerDay: number | null; usdPerDay: number | null; usdPerReview: number | null };
}

export interface TeamState {
    sync: boolean;
    organization: string | null;
    team: string | null;
    actor: string | null;
    sharing: { shares: boolean; person?: string; reason?: string } | null;
    received: number;
    /** What this person sees of teammates' candidates; null (or absent, from older data) for the general line. */
    candidates?: string | null;
    /** Changes the team database refused in the last 28 days, with the latest reason. */
    refused?: { count: number; latest?: string };
}

export interface GovernanceData {
    coverage: Coverage;
    fixes: Array<{ name: string; state: string; fix: string }>;
    decisions: Decision[];
    decisionsRecent: number;
    qualityGates: QualityGates;
    reviewer: ReviewerUsage;
    team: TeamState;
}

export const STAGE_LABELS: Record<Stage, string> = { brief: 'Brief', edit: 'Edit checks', stop: 'Stop review', push: 'Push gate', pr: 'PR reviewer' };

/** Tokens as a person reads them: 1.7M, 32k. */
export function tokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
    return String(n);
}

export function usd(n: number): string {
    return `$${n.toFixed(2)}`;
}
