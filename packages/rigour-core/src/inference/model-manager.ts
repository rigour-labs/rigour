/**
 * Model Manager — handles downloading, caching, and verifying GGUF models.
 * Models cached at ~/.rigour/models/
 */
import path from 'path';
import fs from 'fs-extra';
import { createHash } from 'crypto';
import { RIGOUR_DIR } from '../storage/db.js';
import { MODELS, FALLBACK_MODELS, type ModelTier, type ModelInfo } from './types.js';

const MODELS_DIR = path.join(RIGOUR_DIR, 'models');
const SHA256_RE = /^[a-f0-9]{64}$/i;

interface ModelCacheMetadata {
    sha256: string;
    sizeBytes: number;
    verifiedAt: string;
    sourceUrl: string;
    sourceEtag?: string;
}

function getModelMetadataPath(filename: string): string {
    return path.join(MODELS_DIR, filename + '.meta.json');
}

function isValidMetadata(raw: any): raw is ModelCacheMetadata {
    return !!raw &&
        typeof raw.sha256 === 'string' &&
        SHA256_RE.test(raw.sha256) &&
        typeof raw.sizeBytes === 'number' &&
        typeof raw.verifiedAt === 'string' &&
        typeof raw.sourceUrl === 'string';
}

export function extractSha256FromEtag(etag: string | null): string | null {
    if (!etag) return null;
    const normalized = etag.replace(/^W\//i, '').replace(/^"+|"+$/g, '').trim();
    return SHA256_RE.test(normalized) ? normalized.toLowerCase() : null;
}

export async function hashFileSha256(filePath: string): Promise<string> {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(filePath);
    for await (const chunk of stream) {
        hash.update(chunk as Buffer);
    }
    return hash.digest('hex');
}

async function writeModelMeta(filename: string, metadata: ModelCacheMetadata): Promise<void> {
    await fs.writeJson(getModelMetadataPath(filename), metadata, { spaces: 2 });
}

async function readModelMeta(filename: string): Promise<ModelCacheMetadata | null> {
    const p = getModelMetadataPath(filename);
    if (!(await fs.pathExists(p))) return null;
    try {
        const raw = await fs.readJson(p);
        return isValidMetadata(raw) ? raw : null;
    } catch {
        return null;
    }
}

/**
 * Check if a single model file is cached and valid.
 */
async function isFileCached(model: ModelInfo): Promise<boolean> {
    const modelPath = path.join(MODELS_DIR, model.filename);
    if (!(await fs.pathExists(modelPath))) return false;
    const metadata = await readModelMeta(model.filename);
    if (!metadata) return false;
    const stat = await fs.stat(modelPath);
    const tolerance = model.sizeBytes * 0.1;
    if (stat.size <= model.sizeBytes - tolerance) return false;
    if (metadata.sizeBytes !== stat.size) return false;
    if (new Date(metadata.verifiedAt).getTime() < stat.mtimeMs) return false;
    return true;
}

/**
 * Check if any model for this tier is cached (fine-tuned or fallback).
 */
export async function isModelCached(tier: ModelTier): Promise<boolean> {
    if (await isFileCached(MODELS[tier])) return true;
    const fb = FALLBACK_MODELS[tier];
    return fb.url !== MODELS[tier].url && await isFileCached(fb);
}

/**
 * Get the path to a cached model (prefers fine-tuned over fallback).
 */
export function getModelPath(tier: ModelTier): string {
    const primary = path.join(MODELS_DIR, MODELS[tier].filename);
    if (fs.pathExistsSync(primary)) return primary;
    return path.join(MODELS_DIR, FALLBACK_MODELS[tier].filename);
}

/**
 * Get model info for a tier.
 */
export function getModelInfo(tier: ModelTier): ModelInfo {
    return MODELS[tier];
}

/**
 * Stream a response body to disk with progress + SHA256.
 * Returns { sha256, downloaded } on success.
 */
async function streamToDisk(
    response: Response,
    tempPath: string,
    model: ModelInfo,
    onProgress?: (message: string, percent?: number) => void,
): Promise<{ sha256: string; downloaded: number }> {
    const contentLength = parseInt(response.headers.get('content-length') || '0', 10);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const writeStream = fs.createWriteStream(tempPath);
    const hash = createHash('sha256');
    let downloaded = 0;
    let lastPct = 0;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        writeStream.write(chunk);
        hash.update(chunk);
        downloaded += value.length;
        if (contentLength > 0) {
            const pct = Math.round((downloaded / contentLength) * 100);
            if (pct >= lastPct + 5) {
                lastPct = pct;
                onProgress?.(`Downloading ${model.name}: ${pct}%`, pct);
            }
        }
    }

    writeStream.end();
    await new Promise<void>((resolve, reject) => {
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
    });

    return { sha256: hash.digest('hex'), downloaded };
}

/**
 * Verify SHA256 against ETag, allowing LFS OID mismatches
 * if the download size is reasonable.
 */
function verifySha256(
    expectedSha256: string | null, actualSha256: string,
    downloaded: number, model: ModelInfo,
): void {
    if (!expectedSha256 || actualSha256 === expectedSha256) return;
    const tolerance = model.sizeBytes * 0.1;
    if (downloaded < model.sizeBytes - tolerance) {
        throw new Error(
            `Checksum mismatch for ${model.name}: ` +
            `expected ${expectedSha256}, got ${actualSha256} ` +
            `(undersized: ${downloaded} bytes)`
        );
    }
    // Size OK — ETag likely a Git LFS OID, not content SHA256
}

/**
 * Download a specific model from its URL, write to disk, save metadata.
 */
async function downloadFromUrl(
    tier: ModelTier,
    model: ModelInfo,
    onProgress?: (message: string, percent?: number) => void,
): Promise<string> {
    const destPath = path.join(MODELS_DIR, model.filename);
    const tempPath = destPath + '.download';

    try {
        const response = await fetch(model.url);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        const expectedSha = extractSha256FromEtag(response.headers.get('etag'));
        const { sha256, downloaded } = await streamToDisk(response, tempPath, model, onProgress);
        verifySha256(expectedSha, sha256, downloaded, model);

        fs.renameSync(tempPath, destPath);
        await writeModelMeta(model.filename, {
            sha256, sizeBytes: downloaded,
            verifiedAt: new Date().toISOString(),
            sourceUrl: model.url,
            sourceEtag: response.headers.get('etag') || undefined,
        });
        onProgress?.(`Model ${model.name} ready`, 100);
        return destPath;
    } catch (error) {
        fs.removeSync(tempPath);
        throw error;
    }
}

/**
 * Download a model from HuggingFace CDN.
 * Tries fine-tuned model first, falls back to stock Qwen if unavailable.
 */
export async function downloadModel(
    tier: ModelTier,
    onProgress?: (message: string, percent?: number) => void
): Promise<string> {
    fs.ensureDirSync(MODELS_DIR);

    if (await isModelCached(tier)) {
        onProgress?.(`Model ${MODELS[tier].name} already cached`, 100);
        return getModelPath(tier);
    }

    const model = MODELS[tier];
    onProgress?.(`Downloading ${model.name} (${model.sizeHuman})...`, 0);

    try {
        return await downloadFromUrl(tier, model, onProgress);
    } catch (error) {
        // Fine-tuned model not available — try stock fallback
        const fallback = FALLBACK_MODELS[tier];
        if (fallback && fallback.url !== model.url) {
            onProgress?.(`Fine-tuned model unavailable, using ${fallback.name}`, 0);
            return downloadFromUrl(tier, fallback, onProgress);
        }
        throw error;
    }
}

/**
 * Ensure a model is available, downloading if needed.
 */
export async function ensureModel(
    tier: ModelTier,
    onProgress?: (message: string, percent?: number) => void
): Promise<string> {
    if (await isModelCached(tier)) {
        return getModelPath(tier);
    }
    return downloadModel(tier, onProgress);
}

/**
 * Get the models directory path.
 */
export function getModelsDir(): string {
    return MODELS_DIR;
}
