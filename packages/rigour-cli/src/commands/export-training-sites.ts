/**
 * `rigour export-training-sites [files...]`: awaited call sites as JSON lines,
 * for the driftbench fix miner. Each line is one site: where it is, what it
 * calls, whether it already handles failure, and the enclosing function's
 * source (the text a model reads). Rigour's own engine extracts them, so
 * training data and runtime inputs are built the same way.
 */
import { execFileSync } from 'child_process';
import { exportCallSites } from '@rigour-labs/core';

const SOURCE = /\.(?:[cm]?[jt]s|[jt]sx)$/i;
const NOT_SOURCE = /\.d\.[cm]?ts$|(?:^|\/)(?:__tests__|__mocks__|tests?|fixtures?)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/i;

export function exportTrainingSitesCommand(cwd: string, files: string[]): void {
    const targets = files.length ? files : trackedSourceFiles(cwd);
    for (const site of exportCallSites(cwd, targets)) process.stdout.write(JSON.stringify(site) + '\n');
}

function trackedSourceFiles(cwd: string): string[] {
    const out = execFileSync('git', ['ls-files', '-z'], { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    return out.split('\0').filter(f => f && SOURCE.test(f) && !NOT_SOURCE.test(f));
}
