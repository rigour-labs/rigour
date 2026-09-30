/**
 * `rigour review --diff-tests`: behaviour changes found by running changed
 * functions before and after the change, as review findings on the changed line.
 */
import { execFileSync } from 'child_process';
import { runDiffTests, type BehaviourChange } from '../deep/diff-tests/run.js';
import { createProvider } from '../inference/index.js';
import type { DeepOptions, Failure } from '../types/index.js';
import type { DiffSource } from './git-diff.js';

export async function diffTestFailures(cwd: string, source: DiffSource | undefined, deep: DeepOptions): Promise<Failure[]> {
    const provider = createProvider(deep);
    await provider.setup();
    try {
        const changes = await runDiffTests({
            cwd, baseRef: baseRef(cwd, source), focusLines: deep.focusLines ?? {}, prBody: deep.prBody,
            provider, inference: { maxTokens: 1024, temperature: 0.2 },
        });
        return changes.map(toFailure);
    } finally {
        provider.dispose();
    }
}

/** What the change is compared with: the merge base for a branch review, HEAD for working changes. */
function baseRef(cwd: string, source: DiffSource | undefined): string {
    if (source?.mode !== 'base') return 'HEAD';
    return execFileSync('git', ['merge-base', source.base, 'HEAD'], { cwd, encoding: 'utf8' }).trim();
}

function toFailure(change: BehaviourChange): Failure {
    return {
        id: 'diff-tests',
        title: `[diff-tests] ${change.name} behaves differently after this change`,
        details: `\`${change.call}\` ${change.before} before this change and ${change.after} after it.`,
        severity: 'medium',
        provenance: 'deep-analysis',
        files: [change.file],
        line: change.line,
        hint: 'If this is intended, say so in the PR description; otherwise restore the old behaviour for this input.',
        source: 'hybrid',
        verified: true,
    };
}
