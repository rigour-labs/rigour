import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { Readable, PassThrough } from 'stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { downloadToFile, type HttpGet, type HttpResponse } from './http-download.js';

const PAYLOAD = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

function response(statusCode: number, body: Buffer | Readable = Buffer.alloc(0), headers: HttpResponse['headers'] = {}): HttpResponse {
    return { statusCode, headers, body: Buffer.isBuffer(body) ? Readable.from([body]) : body };
}

/** Serves PAYLOAD, honouring Range unless told not to. */
function server(opts: { honourRange?: boolean; etag?: string } = {}) {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const get: HttpGet = async (url, headers) => {
        calls.push({ url, headers });
        const range = headers.Range?.match(/bytes=(\d+)-/);
        if (range && opts.honourRange !== false) {
            const start = Number(range[1]);
            if (start >= PAYLOAD.length) return response(416);
            return response(206, PAYLOAD.subarray(start), { 'content-length': String(PAYLOAD.length - start) });
        }
        return response(200, PAYLOAD, { 'content-length': String(PAYLOAD.length), etag: opts.etag });
    };
    return { get, calls };
}

describe('downloadToFile', () => {
    let dir: string;
    let dest: string;

    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigour-dl-'));
        dest = path.join(dir, 'model.gguf.download');
    });
    afterEach(async () => { await fs.remove(dir); });

    it('downloads the full body and hashes it', async () => {
        const { get } = server({ etag: '"abc"' });
        const result = await downloadToFile('https://host/model', dest, { get });
        expect(await fs.readFile(dest)).toEqual(PAYLOAD);
        expect(result).toEqual({ sha256: sha(PAYLOAD), bytes: PAYLOAD.length, etag: '"abc"' });
    });

    it('follows redirects and keeps the x-linked-etag from the first hop', async () => {
        const { get: origin, calls } = server();
        const get: HttpGet = async (url, headers, timeout) => {
            if (url === 'https://hub/model') {
                return response(302, Buffer.alloc(0), { location: 'https://cdn/model', 'x-linked-etag': '"lfs-sha"' });
            }
            return origin(url, headers, timeout);
        };
        const result = await downloadToFile('https://hub/model', dest, { get });
        expect(calls.map(c => c.url)).toEqual(['https://cdn/model']);
        expect(result.etag).toBe('"lfs-sha"');
    });

    it('resumes a partial file with a Range request and hashes the whole file', async () => {
        await fs.writeFile(dest, PAYLOAD.subarray(0, 10));
        const { get, calls } = server();
        const result = await downloadToFile('https://host/model', dest, { get });
        expect(calls[0].headers.Range).toBe('bytes=10-');
        expect(await fs.readFile(dest)).toEqual(PAYLOAD);
        expect(result.sha256).toBe(sha(PAYLOAD));
        expect(result.bytes).toBe(PAYLOAD.length);
    });

    it('restarts from zero when the server ignores Range', async () => {
        await fs.writeFile(dest, Buffer.from('stale-bytes'));
        const { get } = server({ honourRange: false });
        const result = await downloadToFile('https://host/model', dest, { get });
        expect(await fs.readFile(dest)).toEqual(PAYLOAD);
        expect(result.sha256).toBe(sha(PAYLOAD));
    });

    it('restarts when the partial is already past the end (416)', async () => {
        await fs.writeFile(dest, Buffer.concat([PAYLOAD, Buffer.from('extra')]));
        const { get, calls } = server();
        await downloadToFile('https://host/model', dest, { get });
        expect(calls).toHaveLength(2);
        expect(await fs.readFile(dest)).toEqual(PAYLOAD);
    });

    it('rejects non-success responses without creating the file', async () => {
        const get: HttpGet = async () => response(401);
        await expect(downloadToFile('https://host/model', dest, { get })).rejects.toThrow('HTTP 401');
        expect(await fs.pathExists(dest)).toBe(false);
    });

    it('refuses non-https URLs, including redirects to them', async () => {
        const { get } = server();
        await expect(downloadToFile('http://host/model', dest, { get })).rejects.toThrow('non-https');
        const redirecting: HttpGet = async () => response(302, Buffer.alloc(0), { location: 'http://evil/model' });
        await expect(downloadToFile('https://host/model', dest, { get: redirecting })).rejects.toThrow('non-https');
    });

    it('stops after too many redirects', async () => {
        const loop: HttpGet = async (url) => response(302, Buffer.alloc(0), { location: `${url}x` });
        await expect(downloadToFile('https://host/m', dest, { get: loop })).rejects.toThrow('Too many redirects');
    });

    it('aborts a stalled body and keeps the partial for the next resume', async () => {
        const body = new PassThrough();
        body.write(PAYLOAD.subarray(0, 5));
        const get: HttpGet = async () => response(200, body, { 'content-length': String(PAYLOAD.length) });
        await expect(downloadToFile('https://host/model', dest, { get, stallTimeoutMs: 50 })).rejects.toThrow('stalled');
        // The partial file is kept for the next resume (how many bytes reached disk is up to the OS).
        expect(await fs.pathExists(dest)).toBe(true);
        expect((await fs.stat(dest)).size).toBeLessThanOrEqual(5);
    });

    it('reports progress against the full size when resuming', async () => {
        await fs.writeFile(dest, PAYLOAD.subarray(0, 10));
        const { get } = server();
        const seen: Array<[number, number | null]> = [];
        await downloadToFile('https://host/model', dest, { get, onProgress: (d, t) => seen.push([d, t]) });
        expect(seen.at(-1)).toEqual([PAYLOAD.length, PAYLOAD.length]);
    });
});
