/**
 * Hook system types for multi-tool integration.
 *
 * Each AI coding tool (Claude Code, Cursor, Cline, Windsurf)
 * has its own hook format. These types unify the config generation.
 *
 */

export type HookTool = 'claude' | 'cursor' | 'cline' | 'windsurf';

export interface HookCheckerResult {
    status: 'pass' | 'fail' | 'error';
    failures: Array<{
        gate: string;
        file: string;
        message: string;
        severity: string;
        line?: number;
    }>;
    /** Findings the file already had before this change (at HEAD): shown, never blocking. */
    notes?: HookCheckerResult['failures'];
    duration_ms: number;
}
