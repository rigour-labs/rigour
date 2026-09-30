/**
 * `rigour export-review-context --diff <file> [--pr-body <file>]`: the prompt the
 * max tier reviews for each changed file, as JSON lines, for the driftbench
 * review miner (training and runtime inputs are built by the same code).
 */
import fs from 'fs';
import path from 'path';
import { exportReviewContexts } from '@rigour-labs/core';

export async function exportReviewContextCommand(cwd: string, options: { diff: string; prBody?: string }): Promise<void> {
    const diff = fs.readFileSync(path.resolve(cwd, options.diff), 'utf-8');
    const prBody = options.prBody ? fs.readFileSync(path.resolve(cwd, options.prBody), 'utf-8') : undefined;
    for (const context of await exportReviewContexts(cwd, diff, { prBody })) process.stdout.write(JSON.stringify(context) + '\n');
}
