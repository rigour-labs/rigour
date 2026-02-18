/**
 * Hook system types for multi-tool integration.
 *
 * Each AI coding tool (Claude Code, Cursor, Cline, Windsurf)
 * has its own hook format. These types unify the config generation.
 *
 * @since v3.0.0
 */

export type HookTool = 'claude' | 'cursor' | 'cline' | 'windsurf';

export interface HookConfig {
    /** Which tools to generate hooks for */
    tools: HookTool[];
    /** Gates to run in the hook checker (fast subset) */
    fast_gates: string[];
    /** Max execution time in ms before the checker aborts */
    timeout_ms: number;
    /** Whether to block the tool on failure (exit 2) or just warn */
    block_on_failure: boolean;
}

/** The fast gates that can run per-file in <200ms */
export const FAST_GATE_IDS = [
    'hallucinated-imports',
    'promise-safety',
    'security-patterns',
    'file-size',
] as const;

export const DEFAULT_HOOK_CONFIG: HookConfig = {
    tools: ['claude'],
    fast_gates: [...FAST_GATE_IDS],
    timeout_ms: 5000,
    block_on_failure: false,
};

export type FastGateId = typeof FAST_GATE_IDS[number];

export interface HookCheckerResult {
    status: 'pass' | 'fail' | 'error';
    failures: Array<{
        gate: string;
        file: string;
        message: string;
        severity: string;
        line?: number;
    }>;
    duration_ms: number;
}
