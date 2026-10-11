/**
 * A file the change took over `max_file_lines`: under the limit at the base, over it now. A file that was already over
 * is never this change's finding (the gate's own report counts it as what the base had), and a shrinking one is none.
 *
 * A file's length is a team's preference, not a defect, so the finding is a note unless `gates.file_size.block` is on.
 * It is anchored on the file's first changed line, so the verdict sees it as the change's, not as context.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { Config, Failure } from '../types/index.js';

export function fileSizeFailures(cwd: string, changedLines: Record<string, Set<number>>, base: string | undefined, config: Config): Failure[] {
    const max = config.gates.max_file_lines ?? 500;
    if (!base || max <= 0) return []; // without a base the change's share cannot be told; never guessed
    const failures: Failure[] = [];
    for (const [file, lines] of Object.entries(changedLines)) {
        if (lines.size === 0) continue;
        const now = lineCount(readFile(path.join(cwd, file)));
        if (now === undefined || now <= max) continue;
        const before = lineCount(committed(cwd, base, file)) ?? 0;
        if (before > max) continue;
        failures.push({
            id: 'file-size',
            title: `File has ${now} lines (max: ${max})`,
            details: `\`${file}\` went from ${before} to ${now} lines in this change, over \`max_file_lines\` (${max}).`,
            severity: 'low',
            files: [file],
            line: Math.min(...lines),
            certainty: config.gates.file_size?.block ? 'proven' : 'likely',
            hint: 'Split the file by responsibility, or raise max_file_lines if the team accepts files this long.',
        });
    }
    return failures;
}

function lineCount(text: string | undefined): number | undefined {
    return text === undefined ? undefined : text.split('\n').length;
}

function readFile(file: string): string | undefined {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch {
        return undefined;
    }
}

function committed(cwd: string, commit: string, file: string): string | undefined {
    const result = spawnSync('git', ['show', `${commit}:${file}`], { cwd, encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 * 1024 });
    return result.status === 0 ? result.stdout : undefined;
}
