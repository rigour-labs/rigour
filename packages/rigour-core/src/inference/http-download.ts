/**
 * Streaming HTTPS download for large binaries (models, engine archives).
 *
 * Uses node:https rather than global fetch: on large Hugging Face downloads
 * undici's fetch measured ~1.7 MB/s where node:https reached ~17 MB/s on the
 * same host and byte range, which made the first-run model download exceed
 * any reasonable setup window.
 *
 * - follows at most MAX_REDIRECTS redirects, https only
 * - resumes a kept partial file with a Range request (the prefix is re-hashed
 *   so the SHA-256 still covers the whole file)
 * - aborts when no bytes arrive for `stallTimeoutMs` instead of imposing a
 *   wall-clock limit that a slow but healthy connection cannot meet
 */
import https from 'https';
import fs from 'fs-extra';
import { createHash, type Hash } from 'crypto';
import { Transform, type Readable } from 'stream';
import { pipeline } from 'stream/promises';

const MAX_REDIRECTS = 5;
const DEFAULT_STALL_TIMEOUT_MS = 30_000;

export interface HttpResponse {
    statusCode: number;
    headers: Record<string, string | string[] | undefined>;
    body: Readable;
}

export type HttpGet = (url: string, headers: Record<string, string>, timeoutMs: number) => Promise<HttpResponse>;

export interface DownloadOptions {
    onProgress?: (downloadedBytes: number, totalBytes: number | null) => void;
    stallTimeoutMs?: number;
    /** Resume from an existing partial file at `destPath` (default true). */
    resume?: boolean;
    /** Transport override for tests. */
    get?: HttpGet;
}

export interface DownloadResult {
    sha256: string;
    bytes: number;
    /** ETag seen on any hop; Hugging Face exposes the LFS SHA-256 as x-linked-etag. */
    etag: string | null;
}

export async function downloadToFile(url: string, destPath: string, options: DownloadOptions = {}): Promise<DownloadResult> {
    const stallMs = options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
    const get = options.get ?? httpsGet;
    let existing = options.resume === false ? 0 : await partialSize(destPath);
    let { response, etag } = await followRedirects(url, rangeFrom(existing), get, stallMs);

    if (response.statusCode === 416 && existing > 0) {
        // The partial is already at or past the end: start over once, from zero.
        response.body.resume();
        await fs.remove(destPath);
        existing = 0;
        ({ response, etag } = await followRedirects(url, rangeFrom(0), get, stallMs));
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
        response.body.resume();
        throw new Error(`HTTP ${response.statusCode} for ${url}`);
    }

    const resumed = response.statusCode === 206 && existing > 0;
    const hash = createHash('sha256');
    if (resumed) await hashFilePrefix(destPath, hash);
    const startBytes = resumed ? existing : 0;
    const total = contentLength(response.headers, startBytes);

    const bytes = await writeBody(response.body, destPath, hash, {
        append: resumed, startBytes, total, stallMs, onProgress: options.onProgress,
    });
    return { sha256: hash.digest('hex'), bytes, etag };
}

function rangeFrom(offset: number): Record<string, string> {
    return offset > 0 ? { Range: `bytes=${offset}-` } : {};
}

async function partialSize(filePath: string): Promise<number> {
    try {
        return (await fs.stat(filePath)).size;
    } catch {
        return 0;
    }
}

async function followRedirects(url: string, headers: Record<string, string>, get: HttpGet, timeoutMs: number) {
    let current = url;
    let etag: string | null = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        if (new URL(current).protocol !== 'https:') {
            throw new Error(`Refusing non-https download URL: ${current}`);
        }
        const response = await get(current, headers, timeoutMs);
        etag = etag ?? headerValue(response.headers, 'x-linked-etag') ?? headerValue(response.headers, 'etag');
        const location = headerValue(response.headers, 'location');
        if (response.statusCode >= 300 && response.statusCode < 400 && location) {
            response.body.resume();
            current = new URL(location, current).toString();
            continue;
        }
        return { response, etag };
    }
    throw new Error(`Too many redirects downloading ${url}`);
}

interface WriteOptions {
    append: boolean;
    startBytes: number;
    total: number | null;
    stallMs: number;
    onProgress?: DownloadOptions['onProgress'];
}

async function writeBody(body: Readable, destPath: string, hash: Hash, opts: WriteOptions): Promise<number> {
    let downloaded = opts.startBytes;
    let stallTimer: NodeJS.Timeout | undefined;
    const armStall = () => {
        clearTimeout(stallTimer);
        stallTimer = setTimeout(() => {
            body.destroy(new Error(`Download stalled: no data for ${opts.stallMs / 1000}s`));
        }, opts.stallMs);
    };

    const tap = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
            armStall();
            hash.update(chunk);
            downloaded += chunk.length;
            opts.onProgress?.(downloaded, opts.total);
            callback(null, chunk);
        },
    });

    armStall();
    try {
        await pipeline(body, tap, fs.createWriteStream(destPath, { flags: opts.append ? 'a' : 'w' }));
    } finally {
        clearTimeout(stallTimer);
    }
    return downloaded;
}

async function hashFilePrefix(filePath: string, hash: Hash): Promise<void> {
    const stream = fs.createReadStream(filePath);
    try {
        for await (const chunk of stream) hash.update(chunk as Buffer);
    } finally {
        stream.destroy();
    }
}

function contentLength(headers: HttpResponse['headers'], offset: number): number | null {
    const value = Number(headerValue(headers, 'content-length'));
    return Number.isFinite(value) && value > 0 ? value + offset : null;
}

function headerValue(headers: HttpResponse['headers'], name: string): string | null {
    const value = headers[name];
    if (Array.isArray(value)) return value[0] ?? null;
    return value ?? null;
}

const httpsGet: HttpGet = (url, headers, timeoutMs) => new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { 'user-agent': 'rigour-cli', ...headers } }, (res) => {
        resolve({ statusCode: res.statusCode ?? 0, headers: res.headers, body: res });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`No response from ${new URL(url).host} after ${timeoutMs / 1000}s`)));
    request.on('error', reject);
});
