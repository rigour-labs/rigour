import { describe, it, expect } from 'vitest';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { extractSha256FromEtag, hashFileSha256 } from './model-manager.js';

describe('model manager integrity helpers', () => {
    it('extracts sha256 digest from a strong ETag', () => {
        const digest = 'a'.repeat(64);
        expect(extractSha256FromEtag(`"${digest}"`)).toBe(digest);
        expect(extractSha256FromEtag(`W/"${digest}"`)).toBe(digest);
    });

    it('returns null for non-sha ETags', () => {
        expect(extractSha256FromEtag('"not-a-digest"')).toBeNull();
        expect(extractSha256FromEtag(null)).toBeNull();
    });

    it('hashes file contents with sha256', async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigour-model-hash-'));
        const filePath = path.join(dir, 'sample.gguf');
        await fs.writeFile(filePath, 'rigour-model-check');

        const digest = await hashFileSha256(filePath);
        expect(digest).toBe('e123266ea4b37a81948a0a844dd58eddfc81737aa6fdf9dafc818fd23bae75f0');

        await fs.remove(dir);
    });
});
