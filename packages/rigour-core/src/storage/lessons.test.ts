import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { getRepositoryId, shouldValidateInteractionLesson } from './lessons.js';

const roots: string[] = [];

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.remove(root))); });

describe('getRepositoryId', () => {
    it('uses normalized origin identity instead of a basename', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rigour-repo-id-'));
        roots.push(root);
        await fs.ensureDir(path.join(root, '.git'));
        await fs.writeFile(path.join(root, '.git', 'config'), '[remote "origin"]\nurl = git@github.com:Rigour-Labs/Rigour.git\n');

        const first = await getRepositoryId(root);
        const second = await getRepositoryId(path.join(root, '..', path.basename(root)));
        expect(first).toBe(second);
        expect(first).toHaveLength(64);
    });

    it('uses the shared origin identity from a linked worktree', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rigour-worktree-id-'));
        roots.push(root);
        const common = path.join(root, 'common');
        const linkedGit = path.join(common, 'worktrees', 'feature');
        const worktree = path.join(root, 'checkout');
        await fs.ensureDir(linkedGit);
        await fs.ensureDir(worktree);
        await fs.writeFile(path.join(worktree, '.git'), `gitdir: ${linkedGit}\n`);
        await fs.writeFile(path.join(linkedGit, 'commondir'), '../..\n');
        await fs.writeFile(path.join(common, 'config'), '[remote "origin"]\nurl = https://github.com/rigour-labs/rigour.git\n');
        const regular = path.join(root, 'regular');
        await fs.ensureDir(path.join(regular, '.git'));
        await fs.writeFile(path.join(regular, '.git', 'config'), '[remote "origin"]\nurl = git@github.com:Rigour-Labs/Rigour.git\n');

        expect(await getRepositoryId(worktree)).toBe(await getRepositoryId(regular));
        expect(await getRepositoryId(worktree)).toHaveLength(64);
    });
});

describe('interaction lesson validation', () => {
    const evidence = { tool: 'rigour_context_scope', outcome: 'success' as const, requestId: 'req-1' };

    it('keeps repeated unverified interaction as evidence only', () => {
        expect(shouldValidateInteractionLesson(evidence, 0)).toBe(false);
        expect(shouldValidateInteractionLesson(evidence, 2)).toBe(false);
    });

    it('validates deterministic or repeatedly verified outcomes', () => {
        expect(shouldValidateInteractionLesson({ ...evidence, deterministic: true, reusableClaim: 'Use scoped retrieval before edits.' }, 0)).toBe(true);
        expect(shouldValidateInteractionLesson({ ...evidence, verifiedOutcome: true, reusableClaim: 'Run the focused test suite.' }, 3)).toBe(true);
    });

    it('does not turn a successful tool call into reusable knowledge', () => {
        expect(shouldValidateInteractionLesson({ ...evidence, deterministic: true }, 3)).toBe(false);
    });
});
