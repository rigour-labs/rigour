/**
 * One repository, one id, whatever its origin's form: an https clone, an SSH remote and an SSH host alias of the same
 * repository share an id, and rows a local store filed under an alias's old id move to the new one, once.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repository-id-'));
const sshConfig = path.join(root, 'ssh_config');
const checkout = (name: string, origin: string) => {
    const dir = path.join(root, name);
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.git', 'config'), `[remote "origin"]\n\turl = ${origin}\n`);
    return dir;
};

describe('a repository\'s id', () => {
    beforeAll(() => {
        fs.writeFileSync(sshConfig, 'Host work-forge\n    HostName forge.example.com\n');
        vi.stubEnv('RIGOUR_SSH_CONFIG', sshConfig);
        vi.stubEnv('RIGOUR_HOME', path.join(root, 'home'));
    });
    afterAll(() => {
        vi.unstubAllEnvs();
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('is the same for an https clone, an SSH remote and an SSH host alias of one repository', async () => {
        const { getRepositoryId, legacyRepositoryId, originOf } = await import('./repository-origin.js');
        const https = checkout('https', 'https://forge.example.com/Example-Org/widgets.git');
        const ssh = checkout('ssh', 'git@forge.example.com:example-org/widgets.git');
        const sshUrl = checkout('ssh-url', 'ssh://git@forge.example.com:22/example-org/widgets.git');
        const alias = checkout('alias', 'git@work-forge:example-org/widgets.git');
        const id = await getRepositoryId(https);
        for (const dir of [ssh, sshUrl, alias]) expect(await getRepositoryId(dir)).toBe(id);
        expect(await originOf(alias)).toBe('https://forge.example.com/example-org/widgets');
        // Only the alias had another id before; the others never changed.
        expect(legacyRepositoryId(alias)).toBeDefined();
        for (const dir of [https, ssh]) expect(legacyRepositoryId(dir)).toBeUndefined();
    });

    it('keeps an alias the ssh config does not name, and another repository apart', async () => {
        const { getRepositoryId, originOf } = await import('./repository-origin.js');
        const unknown = checkout('unknown', 'git@no-such-alias:example-org/widgets.git');
        expect(await originOf(unknown)).toBe('https://no-such-alias/example-org/widgets');
        const other = checkout('other', 'git@work-forge:example-org/gadgets.git');
        expect(await getRepositoryId(other)).not.toBe(await getRepositoryId(checkout('widgets', 'https://forge.example.com/example-org/widgets')));
    });

    it('moves rows filed under an alias\'s old id to the new one, once, keeping a row already under the new id', async () => {
        const { getRepositoryId, legacyRepositoryId } = await import('./repository-origin.js');
        const { openDatabase } = await import('./db.js');
        const { registerRepository } = await import('./lessons.js');
        const alias = checkout('rekey', 'git@work-forge:example-org/rekeyed.git');
        const legacy = legacyRepositoryId(alias)!;
        const id = await getRepositoryId(alias);
        const db = (await openDatabase())!;
        try {
            const insert = (lessonId: string, repository: string) => db.run(
                `INSERT INTO lessons (id, repository_id, visibility, state, kind, subject, evidence_json, confidence, source, created_at, updated_at)
                 VALUES (?, ?, 'team', 'candidate', 'memory', ?, '{}', 0.5, 'rigour_remember', 1, 1)`, lessonId, repository, `${lessonId}: synthetic`);
            await insert('lesson-old', legacy);
            await insert('lesson-new', id);
            await registerRepository(db, alias, id);
            const rows = await db.all('SELECT id, repository_id FROM lessons WHERE id IN (?, ?) ORDER BY id', 'lesson-new', 'lesson-old');
            expect(rows).toEqual([{ id: 'lesson-new', repository_id: id }, { id: 'lesson-old', repository_id: id }]);
            expect(await db.get('SELECT COUNT(*) AS n FROM repositories WHERE id = ?', legacy)).toEqual({ n: 0 });
        } finally {
            await db.close();
        }
    });
});
