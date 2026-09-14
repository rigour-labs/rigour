import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from './db.js';
import { decryptLocalPayload, encryptLocalPayload } from './local-encryption.js';
import { getRepositoryId, shouldValidateInteractionLesson } from './lessons.js';
import { queueLocalLessonsForTeam } from './team-import.js';

const roots: string[] = [];

afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(roots.splice(0).map((root) => fs.remove(root)));
});

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

describe('local lesson team import', () => {
    it('dry-runs, assigns legacy ownership, and queues each lesson version once', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rigour-team-import-'));
        roots.push(root);
        await fs.ensureDir(path.join(root, '.git'));
        await fs.writeFile(path.join(root, '.git', 'config'), '[remote "origin"]\nurl = https://github.com/acme/service.git\n');
        vi.stubEnv('RIGOUR_ORGANIZATION_ID', 'acme');
        vi.stubEnv('RIGOUR_TEAM_ID', 'platform');
        vi.stubEnv('RIGOUR_ACTOR_ID', 'alice');
        vi.stubEnv('RIGOUR_TEAM_DATABASE_URL', 'postgresql://alice@127.0.0.1/rigour');
        vi.stubEnv('RIGOUR_LOCAL_CACHE_KEY', Buffer.alloc(32, 7).toString('base64'));
        const repositoryId = await getRepositoryId(root);
        const databasePath = path.join(root, 'rigour.db');
        const db = await openDatabase(databasePath);
        expect(db).not.toBeNull();
        const now = Date.now();
        await db!.run(
            `INSERT INTO lessons (
                id, repository_id, actor_id, team_id, visibility, state, kind, subject,
                evidence_json, confidence, source, created_at, updated_at
            ) VALUES (?, ?, NULL, NULL, 'personal', 'candidate', 'interaction', ?, ?, 0.3, 'mcp', ?, ?)`,
            'lesson-legacy',
            repositoryId,
            'Prefer scoped retrieval.',
            await encryptLocalPayload({ requestId: 'legacy-request' }),
            now,
            now,
        );
        await db!.close();

        const preview = await queueLocalLessonsForTeam([root], { databasePath, dryRun: true });
        expect(preview).toMatchObject({ matched: 1, eligible: 1, wouldQueue: 1, queued: 0 });

        const queued = await queueLocalLessonsForTeam([root], { databasePath });
        expect(queued).toMatchObject({ matched: 1, eligible: 1, wouldQueue: 1, queued: 1 });

        const existingOutbox = await openDatabase(databasePath);
        await existingOutbox!.run(
            'UPDATE sync_outbox SET id = ? WHERE entity_id = ?',
            'outbox-created-by-normal-learning',
            'lesson-legacy',
        );
        await existingOutbox!.close();

        const repeated = await queueLocalLessonsForTeam([root], { databasePath });
        expect(repeated).toMatchObject({ matched: 1, eligible: 1, wouldQueue: 0, queued: 0, alreadyQueued: 1 });

        const verified = await openDatabase(databasePath);
        const lesson = await verified!.get('SELECT actor_id, team_id, visibility, state FROM lessons WHERE id = ?', 'lesson-legacy');
        expect(lesson).toMatchObject({ actor_id: 'alice', team_id: 'platform', visibility: 'personal', state: 'candidate' });
        const outbox = await verified!.get('SELECT payload_json FROM sync_outbox WHERE entity_id = ?', 'lesson-legacy');
        const payload = await decryptLocalPayload<Record<string, unknown>>(outbox.payload_json);
        expect(payload).toMatchObject({ id: 'lesson-legacy', actorId: 'alice', teamId: 'platform', visibility: 'personal', state: 'candidate' });
        await verified!.close();
    });
});
