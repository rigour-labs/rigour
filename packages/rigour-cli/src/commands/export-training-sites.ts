/**
 * `rigour export-training-sites [files...]`: awaited call sites as JSON lines,
 * for the driftbench fix miner. Each line is one site: where it is, what it
 * calls, whether it already handles failure, and the enclosing function's
 * source (the text a model reads). Rigour's own engine extracts them, so
 * training data and runtime inputs are built the same way.
 */
import { exportCallSites } from '@rigour-labs/core';
import { trackedSourceFiles } from '../utils/tracked-sources.js';

export function exportTrainingSitesCommand(cwd: string, files: string[]): void {
    const targets = files.length ? files : trackedSourceFiles(cwd);
    for (const site of exportCallSites(cwd, targets)) process.stdout.write(JSON.stringify(site) + '\n');
}
