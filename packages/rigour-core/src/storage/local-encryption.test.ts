import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadOrCreateFileKey } from './local-encryption.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(directory => fs.remove(directory)));
});

async function temporaryKeyPath(): Promise<string> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rigour-key-test-'));
    temporaryDirectories.push(directory);
    return path.join(directory, 'team-cache.key');
}

describe('local encryption key storage', () => {
    it('returns one key when concurrent processes initialize the same path', async () => {
        const keyPath = await temporaryKeyPath();

        const keys = await Promise.all(
            Array.from({ length: 32 }, () => loadOrCreateFileKey(keyPath)),
        );

        expect(new Set(keys.map(key => key.toString('base64')))).toHaveLength(1);
        expect(await fs.readFile(keyPath, 'utf8')).toBe(keys[0].toString('base64'));
    });

    it('rejects an invalid existing key without replacing it', async () => {
        const keyPath = await temporaryKeyPath();
        await fs.writeFile(keyPath, 'not-a-valid-key', 'utf8');

        await expect(loadOrCreateFileKey(keyPath)).rejects.toThrow(
            'must contain a base64-encoded 32-byte key',
        );
        expect(await fs.readFile(keyPath, 'utf8')).toBe('not-a-valid-key');
    });

    it('accepts an existing key without base64 padding for backward compatibility', async () => {
        const keyPath = await temporaryKeyPath();
        const encodedKey = Buffer.alloc(32, 7).toString('base64').replace(/=+$/, '');
        await fs.writeFile(keyPath, encodedKey, 'utf8');

        expect((await loadOrCreateFileKey(keyPath)).equals(Buffer.alloc(32, 7))).toBe(true);
    });
});
