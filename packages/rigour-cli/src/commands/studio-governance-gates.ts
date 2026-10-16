/**
 * Governance quality rules: what this repository's rigour.yml enforces (or Rigour's defaults without one), whether
 * the gates block or only report, the quality score over time (score-history.jsonl) and how often the push gate
 * passed or held a push (the threads).
 */
import path from 'path';
import type { Config, ScoreEntry, ThreadEvent } from '@rigour-labs/core';
import { jsonLines } from './studio-threads.js';

const SCORE_POINTS = 30;
const WINDOW_MS = 28 * 24 * 60 * 60 * 1000;

export interface GateRule { name: string; setting: string; blocks: boolean | null; note?: string }

export interface QualityGates {
    /** `rigour.yml`, or null when Rigour runs on its defaults. */
    configFile: string | null;
    /** Every gate (edit, stop, push) only says what it would have blocked: set by the team's rigour.yml, or this clone. */
    reportOnly: { on: boolean; setBy: 'team' | 'this clone' | null };
    rules: GateRule[];
    /** The project's own commands Rigour runs at push. */
    commands: Array<{ name: string; command: string }>;
    score: Array<{ at: string; score: number; status: string }>;
    /** Pushes in the last 28 days; null when the push gate never ran here. */
    pushes: { passed: number; held: number } | null;
}

export interface GateInputs {
    now: Date;
    config: Config;
    configFile: string | null;
    /** The person's report-only switch for this clone (report-only.ts), read only when the team sets nothing. */
    personalReportOnly: boolean;
    scores: ScoreEntry[];
    threads: ThreadEvent[];
}

export function buildQualityGates(input: GateInputs): QualityGates {
    const team = input.config.hooks?.report_only;
    const reportOnly = team !== undefined ? { on: team, setBy: 'team' as const } : { on: input.personalReportOnly, setBy: input.personalReportOnly ? 'this clone' as const : null };
    const pushes = input.threads.filter(e => e.kind === 'push');
    const recent = pushes.filter(e => input.now.getTime() - Date.parse(e.at) <= WINDOW_MS);
    const commands = Object.entries(input.config.commands ?? {}).filter((e): e is [string, string] => typeof e[1] === 'string' && !!e[1].trim());
    return {
        configFile: input.configFile,
        reportOnly,
        rules: gateRules(input.config),
        commands: commands.map(([name, command]) => ({ name, command })),
        score: input.scores.filter(s => Number.isFinite(s.score) && Number.isFinite(Date.parse(s.timestamp)))
            .sort((a, b) => a.timestamp.localeCompare(b.timestamp)).slice(-SCORE_POINTS)
            .map(s => ({ at: s.timestamp, score: s.score, status: s.status })),
        pushes: pushes.length ? { passed: recent.filter(e => e.passed !== false).length, held: recent.filter(e => e.passed === false).length } : null,
    };
}

/** The settings a team lead asks about, and whether each blocks (`null`: a limit whose findings follow the proof rule). */
function gateRules(config: Config): GateRule[] {
    const g = config.gates;
    const optIn = (name: string, setting: { enabled?: boolean; block?: boolean } | undefined, what: string): GateRule =>
        ({ name, setting: setting?.enabled === false ? 'off' : what, blocks: setting?.enabled === false ? null : !!setting?.block });
    return [
        { name: 'File length', setting: `${g.max_file_lines} lines`, blocks: !!g.file_size?.block },
        { name: 'Function complexity', setting: `at most ${g.ast?.complexity}`, blocks: null },
        { name: 'Parameters per function', setting: `at most ${g.ast?.max_params}`, blocks: null },
        { name: 'TODO and FIXME comments', setting: g.forbid_todos || g.forbid_fixme ? 'not allowed' : 'allowed', blocks: null },
        { ...optIn('Security patterns', g.security, `on, from ${g.security?.block_on_severity} severity`), note: 'A credential in a real secret\'s format always blocks; the other patterns block only when this is set to block.' },
        optIn('Unused exports', g.unused_exports as { enabled?: boolean; block?: boolean }, 'on'),
        optIn('Duplicate functions', g.duplicate_functions, 'on'),
        optIn('Orphan files', g.orphan_files as { enabled?: boolean; block?: boolean }, 'on'),
        optIn('Checks compiled from lessons', g.compiled_lessons, 'on'),
        optIn('Side effects (timers, loops, restarts)', g.side_effect_analysis as { enabled?: boolean; block?: boolean }, 'on'),
    ];
}

export function readScores(roots: string[]): ScoreEntry[] {
    return roots.flatMap(root => jsonLines<ScoreEntry>(path.join(root, '.rigour', 'score-history.jsonl')))
        .filter(s => typeof s?.timestamp === 'string' && typeof s.score === 'number');
}
