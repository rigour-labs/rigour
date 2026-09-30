import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { localModel } from './sidecar-provider.js';

let dir: string | undefined;
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = undefined; });

describe('a local GGUF for --model-path', () => {
    it('is used as is, never reported as a fallback', async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-model-'));
        const file = path.join(dir, 'rigour-max-candidate-q4_k_m.gguf');
        fs.writeFileSync(file, Buffer.alloc(2_000_000));
        expect(await localModel('max', file)).toEqual({
            path: file, fallback: false,
            info: { tier: 'max', name: 'rigour-max-candidate-q4_k_m.gguf (local)', filename: 'rigour-max-candidate-q4_k_m.gguf', url: '', sizeBytes: 2_000_000, sizeHuman: '2MB' },
        });
    });

    it('fails clearly when the file is missing, rather than downloading something else', async () => {
        await expect(localModel('max', '/nonexistent/model.gguf')).rejects.toThrow('Model file not found: /nonexistent/model.gguf');
    });
});
