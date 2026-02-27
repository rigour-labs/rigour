/**
 * Model Manager — handles downloading, caching, and verifying GGUF models.
 * Models cached at ~/.rigour/models/
 */
import path from 'path';
import fs from 'fs-extra';
import { createHash } from 'crypto';
import { RIGOUR_DIR } from '../storage/db.js';
import { MODELS, type ModelTier, type ModelInfo } from './types.js';

const MODELS_DIR = path.join(RIGOUR_DIR, 'models');
const SHA256_RE = /^[a-f0-9]{64}$/i;

interface ModelCacheMetadata {
    sha256: string;
    sizeBytes: number;
    verifiedAt: string;
    sourceUrl: string;
    sourceEtag?: string;
}

function getModelMetadataPath(tier: ModelTier): string {
    return path.join(MODELS_DIR, MODELS[tier].filename + '.meta.json');
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

async function writeModelMetadata(tier: ModelTier, metadata: ModelCacheMetadata): Promise<void> {
    const metadataPath = getModelMetadataPath(tier);
    await fs.writeJson(metadataPath, metadata, { spaces: 2 });
}

async function readModelMetadata(tier: ModelTier): Promise<ModelCacheMetadata | null> {
    const metadataPath = getModelMetadataPath(tier);
    if (!(await fs.pathExists(metadataPath))) {
        return null;
    }
    try {
        const raw = await fs.readJson(metadataPath);
        return isValidMetadata(raw) ? raw : null;
    } catch {
        return null;
    }
}

/**
 * Check if a model is already downloaded and valid.
 */
export async function isModelCached(tier: ModelTier): Promise<boolean> {
    const model = MODELS[tier];
    const modelPath = path.join(MODELS_DIR, model.filename);
    if (!(await fs.pathExists(modelPath))) return false;

    const metadata = await readModelMetadata(tier);
    if (!metadata) return false;

    // Size check + "changed since verification" check.
    const stat = await fs.stat(modelPath);
    const tolerance = model.sizeBytes * 0.1;
    if (stat.size <= model.sizeBytes - tolerance) return false;
    if (metadata.sizeBytes !== stat.size) return false;
    if (new Date(metadata.verifiedAt).getTime() < stat.mtimeMs) return false;
    return true;
}

/**
 * Get the path to a cached model.
 */
export function getModelPath(tier: ModelTier): string {
    return path.join(MODELS_DIR, MODELS[tier].filename);
}

/**
 * Get model info for a tier.
 */
export function getModelInfo(tier: ModelTier): ModelInfo {
    return MODELS[tier];
}

/**
 * Download a model from HuggingFace CDN.
 * Calls onProgress with status updates.
 */
export async function downloadModel(
    tier: ModelTier,
    onProgress?: (message: string, percent?: number) => void
): Promise<string> {
    const model = MODELS[tier];
    const destPath = path.join(MODELS_DIR, model.filename);
    const tempPath = destPath + '.download';

    fs.ensureDirSync(MODELS_DIR);

    // Already cached
    if (await isModelCached(tier)) {
        onProgress?.(`Model ${model.name} already cached`, 100);
        return destPath;
    }

    onProgress?.(`Downloading ${model.name} (${model.sizeHuman})...`, 0);

    try {
        const response = await fetch(model.url);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        const expectedSha256 = extractSha256FromEtag(response.headers.get('etag'));

        const contentLength = parseInt(response.headers.get('content-length') || '0', 10);
        const reader = response.body?.getReader();
        if (!reader) throw new Error('No response body');

        const writeStream = fs.createWriteStream(tempPath);
        const hash = createHash('sha256');
        let downloaded = 0;
        let lastProgressPercent = 0;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = Buffer.from(value);
            writeStream.write(chunk);
            hash.update(chunk);
            downloaded += value.length;

            if (contentLength > 0) {
                const percent = Math.round((downloaded / contentLength) * 100);
                if (percent >= lastProgressPercent + 5) { // Report every 5%
                    lastProgressPercent = percent;
                    onProgress?.(`Downloading ${model.name}: ${percent}%`, percent);
                }
            }
        }

        writeStream.end();
        await new Promise<void>((resolve, reject) => {
            writeStream.on('finish', resolve);
            writeStream.on('error', reject);
        });

        const actualSha256 = hash.digest('hex');
        if (expectedSha256 && actualSha256 !== expectedSha256) {
            throw new Error(`Model checksum mismatch for ${model.name}: expected ${expectedSha256}, got ${actualSha256}`);
        }

        // Atomic rename
        fs.renameSync(tempPath, destPath);
        await writeModelMetadata(tier, {
            sha256: actualSha256,
            sizeBytes: downloaded,
            verifiedAt: new Date().toISOString(),
            sourceUrl: model.url,
            sourceEtag: response.headers.get('etag') || undefined,
        });
        onProgress?.(`Model ${model.name} ready`, 100);

        return destPath;
    } catch (error) {
        // Clean up temp file on failure
        fs.removeSync(tempPath);
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
