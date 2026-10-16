/**
 * One repository's lessons are found whatever form a checkout's origin takes: stored ids never change, and a checkout
 * whose origin is an SSH remote or alias also matches the id an https clone of the same repository files under.
 */
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repository-id-'));
const checkout = (name: string, origin: string) => {
    const dir = path.join(root, name);
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.git', 'config'), `[remote "origin"]\n\turl = ${origin}\n`);
    return dir;
};
const httpsId = (canonical: string) => createHash('sha256').update(canonical).digest('hex');

describe("a repository's ids", () => {
    beforeAll(() => {
        const sshConfig = path.join(root, 'ssh_config');
        fs.writeFileSync(sshConfig, 'Host work-forge\n    HostName forge.example.com\n');
        vi.stubEnv('RIGOUR_SSH_CONFIG', sshConfig);
    });
    afterAll(() => {
        vi.unstubAllEnvs();
        fs.rmSync(root, { recursive: true, force: true });
    });

    it("never changes a checkout's own id", async () => {
        const { getRepositoryId } = await import('./repository-origin.js');
        const alias = checkout('alias', 'git@work-forge:example-org/widgets.git');
        expect(await getRepositoryId(alias)).toBe(httpsId('https://work-forge/example-org/widgets'));
    });

    it('matches the https clone of the same repository from every SSH form, aliases resolved', async () => {
        const { sameRepositoryIds, getRepositoryId } = await import('./repository-origin.js');
        const https = checkout('https', 'https://forge.example.com/Example-Org/widgets.git');
        const cloned = await getRepositoryId(https);
        for (const origin of [
            'git@work-forge:example-org/widgets.git',
            'work-forge:example-org/widgets.git',
            'alice@work-forge:example-org/widgets',
            'ssh://git@work-forge:22/example-org/widgets.git',
            'git@forge.example.com:example-org/widgets.git',
            'ssh://git@forge.example.com/example-org/widgets.git',
        ]) {
            const dir = checkout(`form-${httpsId(origin).slice(0, 8)}`, origin);
            expect(sameRepositoryIds(dir), origin).toContain(cloned);
            expect(sameRepositoryIds(dir)[0], origin).toBe(await getRepositoryId(dir));
        }
        expect(sameRepositoryIds(https)).toEqual([cloned]);
    });

    it('never matches another repository, and keeps an alias the ssh config does not name', async () => {
        const { sameRepositoryIds, getRepositoryId } = await import('./repository-origin.js');
        const other = checkout('other', 'git@work-forge:example-org/gadgets.git');
        expect(sameRepositoryIds(other)).not.toContain(await getRepositoryId(checkout('widgets', 'https://forge.example.com/example-org/widgets')));
        const unknown = checkout('unknown', 'git@no-such-alias:example-org/widgets.git');
        expect(sameRepositoryIds(unknown)).toContain(httpsId('https://no-such-alias/example-org/widgets'));
    });

    it('reads local paths as no remote, and matches https written with a credential, http or a trailing slash', async () => {
        const { sameRepositoryIds, getRepositoryId } = await import('./repository-origin.js');
        for (const local of ['C:\\repos\\widgets', 'C:/repos/widgets.git']) {
            const dir = checkout(`local-${httpsId(local).slice(0, 8)}`, local);
            expect(sameRepositoryIds(dir), local).toEqual([await getRepositoryId(dir)]);
        }
        const clean = httpsId('https://forge.example.com/example-org/widgets');
        for (const origin of ['https://x-access-token:abc@forge.example.com/example-org/widgets.git', 'http://forge.example.com/example-org/widgets', 'https://forge.example.com/example-org/widgets.git/']) {
            const dir = checkout(`https-${httpsId(origin).slice(0, 8)}`, origin);
            expect(sameRepositoryIds(dir), origin).toContain(clean);
        }
    });
});
