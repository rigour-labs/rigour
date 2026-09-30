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

const { checkForUpdates, downloadModel, getCachedModel, normalizeModelVersion } = await import('./model-manager.js');
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
        await fs.outputJson(path.join(modelsDir, '.latest_version.json'), { format: 2, version: '5', checkedAt: new Date().toISOString() });
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

    it('retries the fine-tuned model once a day when only the stock fallback is cached', async () => {
        const failing: HttpGet = (url) => (url.includes('rigour-labs/') ? unauthorized : ok(PAYLOAD, PAYLOAD_SHA));
        const stockPath = await downloadModel('lite', undefined, failing);

        const requested: string[] = [];
        const again = await downloadModel('lite', undefined, (url) => { requested.push(url); return unauthorized; });
        expect(requested).toEqual([]);  // failed less than a day ago: keep the fallback, no request
        expect(again).toBe(stockPath);

        await fs.writeJson(path.join(modelsDir, '.fine-tuned-unavailable-lite.json'), { failedAt: '2000-01-01T00:00:00Z', url: MODELS.lite.url });
        const fineTuned = await downloadModel('lite', undefined, (url) => { requested.push(url); return ok(PAYLOAD, PAYLOAD_SHA); });
        expect(requested).toEqual([MODELS.lite.url]);
        expect(path.basename(fineTuned)).toBe(MODELS.lite.filename);
        expect(await fs.pathExists(path.join(modelsDir, '.fine-tuned-unavailable-lite.json'))).toBe(false);
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

    it('accepts a verified fine-tuned file smaller than the size estimate', async () => {
        await cacheFile(MODELS.lite.filename, 397_807_360);  // the published v5 lite model
        expect(await getCachedModel('lite')).toMatchObject({ fallback: false, info: { filename: MODELS.lite.filename } });
    });

    it('ignores a file without verified metadata', async () => {
        await fs.ensureDir(modelsDir);
        await fs.writeFile(path.join(modelsDir, FALLBACK_MODELS.deep.filename), 'partial');
        expect(await getCachedModel('deep')).toBeNull();
    });
});

describe('model versions', () => {
    beforeEach(async () => { await fs.remove(home); vi.unstubAllGlobals(); });

    it('keeps published version strings as they are', () => {
        expect(normalizeModelVersion(5)).toBe('5');
        expect(normalizeModelVersion('5')).toBe('5');
        expect(normalizeModelVersion('v2.1.0')).toBe('2.1.0');
        expect(normalizeModelVersion('5.0')).toBeNull();
        expect(normalizeModelVersion({})).toBeNull();
    });

    it('names the published v5 repositories by default', () => {
        expect(MODELS.lite.url).toBe('https://huggingface.co/rigour-labs/rigour-lite-v5-gguf/resolve/main/rigour-lite-v5-q4_k_m.gguf');
        expect(MODELS.deep.url).toBe('https://huggingface.co/rigour-labs/rigour-deep-v5-gguf/resolve/main/rigour-deep-v5-q4_k_m.gguf');
    });

    it('ignores a version cache from the old SemVer conversion and re-reads the published version', async () => {
        await fs.outputJson(path.join(modelsDir, '.latest_version.json'), { version: '5.0.0', checkedAt: new Date().toISOString() });
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ version: 5 }) })));
        expect(await checkForUpdates()).toBe('5');
        expect(await fs.readJson(path.join(modelsDir, '.latest_version.json'))).toMatchObject({ format: 2, version: '5' });
        expect(MODELS.deep.filename).toBe('rigour-deep-v5-q4_k_m.gguf');
    });
});
