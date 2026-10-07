/**
 * Findings a change did not introduce.
 *
 * A function that was already too complex, or a file that already broke a naming convention, is
 * reported on every review that touches it, and a reviewer learns to skip Rigour's output. The
 * same rules run on the repository as it was at the base (`git archive`, read-only, into a temporary
 * folder; about half a second for a few thousand files), so rules that look across the whole
 * repository see the same picture on both sides. A finding the base already had is counted instead
 * of reported, even when the change moved its numbers (a function at complexity 105 that reaches
 * 109 is the same old problem). Files the change adds are copied in as they are now, so both sides
 * look at the same set of files; findings in those files always count as introduced. Model
 * findings are never compared: the model reviews only the change.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { GateRunner } from '../gates/runner.js';
import type { Config, Failure } from '../types/index.js';
import { normalizeScopePatterns } from '../utils/scope.js';
import type { DiffSource } from './git-diff.js';

/** The commit the change is measured against, or undefined when there is none (a bare diff, a repository without commits). */
export function baseCommit(cwd: string, source: DiffSource | undefined): string | undefined {
    if (!source) return undefined;
    const rev = source.mode === 'base' ? git(cwd, ['merge-base', source.base, 'HEAD'])
        : source.mode === 'since' ? git(cwd, ['rev-parse', '--verify', `${source.commit}^{commit}`])
        : git(cwd, ['rev-parse', '--verify', 'HEAD']);
    return rev?.trim() || undefined;
}

export interface BaseRun {
    failures: Failure[];
    /** Changed files the base did not have. */
    added: Set<string>;
}

/** The rules' findings on the repository at `commit`, with the files the change adds as they are now; records nothing. */
export async function baseFindings(cwd: string, config: Config, commit: string, files: string[]): Promise<BaseRun> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rigour-base-'));
    try {
        extractTree(cwd, commit, dir);
        const added = new Set(files.filter(file => !fs.existsSync(path.join(dir, file))));
        for (const file of added) copyCurrent(cwd, file, dir);
        if (added.size === files.length) return { failures: [], added };
        const modules = path.join(cwd, 'node_modules');
        if (fs.existsSync(modules)) fs.symlinkSync(modules, path.join(dir, 'node_modules'), 'junction');
        // The team's commands find nothing to compare per finding (they report no file), so the base copy never runs them.
        const report = await new GateRunner({ ...config, commands: {} }).run(dir, await normalizeScopePatterns(dir, files), undefined, { record: false });
        return { failures: report.failures, added };
    } finally {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    }
}

/** Split head findings into those the change introduced and those the base already had. */
export function splitIntroduced(head: Failure[], base: BaseRun): { introduced: Failure[]; preexisting: Failure[] } {
    const remaining = new Map<string, number>();
    for (const f of base.failures) remaining.set(identity(f), (remaining.get(identity(f)) ?? 0) + 1);
    const introduced: Failure[] = [];
    const preexisting: Failure[] = [];
    for (const f of head) {
        const key = identity(f);
        const left = remaining.get(key) ?? 0;
        if (left > 0 && !base.added.has(f.files?.[0] ?? '')) {
            remaining.set(key, left - 1);
            preexisting.push(f);
        } else {
            introduced.push(f);
        }
    }
    return { introduced, preexisting };
}

/** A finding without the numbers that move when unrelated lines are added: line numbers, counts, scores. */
function identity(f: Failure): string {
    const strip = (text: string | undefined) => (text ?? '').replace(/\d+/g, '#');
    return [f.id, f.files?.[0] ?? '', strip(f.title), strip(f.details)].join('\u0000');
}

/** The tree at `commit`, written into `dir` (through a tar file: no buffer limit, and tar ships with Windows 10+). */
function extractTree(cwd: string, commit: string, dir: string): void {
    const archive = path.join(dir, '.rigour-base.tar');
    const made = spawnSync('git', ['archive', '--format=tar', '-o', archive, commit], { cwd });
    if (made.status !== 0) throw new Error(`git archive ${commit} failed: ${String(made.stderr).trim()}`);
    const unpacked = spawnSync('tar', ['-xf', archive, '-C', dir]);
    fs.rmSync(archive, { force: true });
    if (unpacked.status !== 0) throw new Error(`tar failed: ${String(unpacked.stderr).trim()}`);
}

function copyCurrent(cwd: string, file: string, dir: string): void {
    const source = path.join(cwd, file);
    if (!fs.existsSync(source)) return;
    const target = path.join(dir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
}

function git(cwd: string, args: string[]): string | undefined {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    return result.status === 0 ? result.stdout : undefined;
}
