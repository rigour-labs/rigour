import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import { afterAll, describe, expect, it, vi } from 'vitest';

/** Install into a scratch folder: the real one is ~/.rigour. */
const home = vi.hoisted(() => {
    const p = require('path') as typeof import('path');
    return p.join(require('os').tmpdir(), `rigour-engine-${process.pid}`);
});
vi.mock('../storage/db.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../storage/db.js')>()), RIGOUR_DIR: home }));

const { installLlamaEngine, managedEngineDir, releaseAssetFor } = await import('./llama-engine.js');

afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

describe('llama.cpp engine install', () => {
    it('pins a checksum for every published platform', () => {
        for (const key of ['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64']) {
            expect(releaseAssetFor(key)?.sha256).toMatch(/^[0-9a-f]{64}$/);
        }
        expect(releaseAssetFor('linux-arm64')).toBeUndefined();
    });

    it.runIf(releaseAssetFor(`${os.platform()}-${os.arch()}`))('refuses an archive that does not match its pinned checksum, and installs nothing', async () => {
        const tampered = async () => ({ statusCode: 200, headers: {}, body: Readable.from([Buffer.from('not the real llama.cpp archive')]) });
        await expect(installLlamaEngine(undefined, tampered)).rejects.toThrow(/does not match its pinned checksum/);
        expect(fs.existsSync(managedEngineDir())).toBe(false);
        expect(fs.readdirSync(path.dirname(managedEngineDir())).filter(f => f.endsWith('.zip'))).toEqual([]);
    });
});
