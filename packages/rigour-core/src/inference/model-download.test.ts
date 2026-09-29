import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { Readable } from 'stream';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpGet } from './http-download.js';

const home = vi.hoisted(() => {
    const p = require('path') as typeof import('path');
    const o = require('os') as typeof import('os');
    return p.join(o.tmpdir(), `rigour-models-${process.pid}-${Date.now()}`);
});
vi.mock('../storage/db.js', () => ({ RIGOUR_DIR: home }));

const { downloadModel, getCachedModel } = await import('./model-manager.js');
const { FALLBACK_MODELS, MODELS } = await import('./types.js');

const modelsDir = path.join(home, 'models');
const PAYLOAD = Buffer.from('gguf-model-bytes');
const PAYLOAD_SHA = createHash('sha256').update(PAYLOAD).digest('hex');

function ok(body: Buffer, sha: string): ReturnType<HttpGet> {
    return Promise.resolve({ statusCode: 200, headers: { 'x-linked-etag': `"${sha}"` }, body: Readable.from([body]) });
}
const unauthorized: ReturnType<HttpGet> = Promise.resolve({ statusCode: 401, headers: {}, body: Readable.from([]) });

describe('downloadModel', () => {
    beforeEach(async () => {
        await fs.remove(home);
        // A fresh version check: no network call to Hugging Face.
        await fs.outputJson(path.join(modelsDir, '.latest_version.json'), { version: '2.0.0', checkedAt: new Date().toISOString() });
    });
    afterAll(async () => { await fs.remove(home); });

    it('falls back to the stock model when the fine-tuned model is unavailable, and says so', async () => {
        const requested: string[] = [];
        const get: HttpGet = (url) => {
            requested.push(url);
            return url.includes('rigour-labs/') ? unauthorized : ok(PAYLOAD, PAYLOAD_SHA);
        };
        const messages: string[] = [];

        const modelPath = await downloadModel('lite', m => messages.push(m), get);

        expect(requested).toEqual([MODELS.lite.url, FALLBACK_MODELS.lite.url]);
        expect(path.basename(modelPath)).toBe(FALLBACK_MODELS.lite.filename);
        expect(messages.some(m => m.includes('Fine-tuned model unavailable (HTTP 401'))).toBe(true);
        const meta = await fs.readJson(`${modelPath}.meta.json`);
        expect(meta).toMatchObject({ sha256: PAYLOAD_SHA, sizeBytes: PAYLOAD.length, sourceUrl: FALLBACK_MODELS.lite.url });
    });

    it('rejects a checksum mismatch and deletes the partial download', async () => {
        const get: HttpGet = () => ok(PAYLOAD, 'f'.repeat(64));
        await expect(downloadModel('lite', undefined, get)).rejects.toThrow('Checksum mismatch');
        expect(await fs.pathExists(path.join(modelsDir, `${FALLBACK_MODELS.lite.filename}.download`))).toBe(false);
        expect(await fs.pathExists(path.join(modelsDir, FALLBACK_MODELS.lite.filename))).toBe(false);
    });
});

describe('getCachedModel', () => {
    beforeEach(async () => { await fs.remove(home); });

    async function cacheFile(filename: string, sizeBytes: number) {
        const file = path.join(modelsDir, filename);
        await fs.ensureDir(modelsDir);
        await fs.writeFile(file, '');
        await fs.truncate(file, sizeBytes); // sparse: no real disk use
        await fs.writeJson(`${file}.meta.json`, {
            sha256: 'a'.repeat(64), sizeBytes, verifiedAt: new Date(Date.now() + 1000).toISOString(), sourceUrl: 'https://x',
        });
    }

    it('returns null when nothing is cached', async () => {
        expect(await getCachedModel('deep')).toBeNull();
    });

    it('reports the stock fallback when only it is cached', async () => {
        await cacheFile(FALLBACK_MODELS.deep.filename, FALLBACK_MODELS.deep.sizeBytes);
        const cached = await getCachedModel('deep');
        expect(cached).toMatchObject({ fallback: true, info: { filename: FALLBACK_MODELS.deep.filename } });
    });

    it('ignores a file without verified metadata', async () => {
        await fs.ensureDir(modelsDir);
        await fs.writeFile(path.join(modelsDir, FALLBACK_MODELS.deep.filename), 'partial');
        expect(await getCachedModel('deep')).toBeNull();
    });
});
