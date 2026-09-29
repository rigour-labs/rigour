/**
 * Model Manager — handles downloading, caching, and verifying GGUF models.
 * Models cached at ~/.rigour/models/
 */
import path from 'path';
import fs from 'fs-extra';
import { createHash } from 'crypto';
import { RIGOUR_DIR } from '../storage/db.js';
import { downloadToFile, type HttpGet } from './http-download.js';
import { MODELS, FALLBACK_MODELS, VERSION_CHECK_URL, BUNDLED_MODEL_VERSION, updateModelVersion, type ModelTier, type ModelInfo } from './types.js';

const MODELS_DIR = path.join(RIGOUR_DIR, 'models');
const VERSION_CACHE_PATH = path.join(MODELS_DIR, '.latest_version.json');
const VERSION_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // Check once per day
const VERSION_CHECK_TIMEOUT_MS = 5000; // 5s timeout — don't block startup
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
    return (await getCachedModel(tier)) !== null;
}

export interface CachedModel {
    path: string;
    info: ModelInfo;
    /** True when the stock fallback is in use because the fine-tuned model is not cached. */
    fallback: boolean;
}

/**
 * The verified model file for a tier, preferring the fine-tuned model over
 * the stock fallback. Null when neither is cached and verified.
 */
export async function getCachedModel(tier: ModelTier): Promise<CachedModel | null> {
    const primary = MODELS[tier];
    if (await isFileCached(primary)) {
        return { path: path.join(MODELS_DIR, primary.filename), info: primary, fallback: false };
    }
    const fallback = FALLBACK_MODELS[tier];
    if (fallback.url !== primary.url && await isFileCached(fallback)) {
        return { path: path.join(MODELS_DIR, fallback.filename), info: fallback, fallback: true };
    }
    return null;
}

/**
 * Get the path to a cached model (prefers fine-tuned over fallback).
 * Existence only; use getCachedModel() for a verified file.
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
 * Reject a download whose SHA-256 differs from the one the server published.
 * Hugging Face publishes the LFS object's SHA-256, which is the content hash,
 * so any mismatch means a corrupt or tampered file.
 */
function verifySha256(expectedSha256: string | null, actualSha256: string, model: ModelInfo): void {
    if (!expectedSha256 || actualSha256 === expectedSha256) return;
    throw new Error(`Checksum mismatch for ${model.name}: expected ${expectedSha256}, got ${actualSha256}`);
}

function progressReporter(model: ModelInfo, onProgress?: (message: string, percent?: number) => void) {
    let lastPct = -5;
    return (downloaded: number, total: number | null) => {
        const size = total ?? model.sizeBytes;
        const pct = Math.min(99, Math.round((downloaded / size) * 100));
        if (pct >= lastPct + 5) {
            lastPct = pct;
            onProgress?.(`Downloading ${model.name}: ${pct}%`, pct);
        }
    };
}

/**
 * Download a model to `<file>.download`, verify it, then move it into place
 * with its metadata. A partial file survives network errors so the next run
 * resumes it; a checksum mismatch deletes it.
 */
async function downloadFromUrl(
    model: ModelInfo,
    onProgress?: (message: string, percent?: number) => void,
    get?: HttpGet,
): Promise<string> {
    const destPath = path.join(MODELS_DIR, model.filename);
    const tempPath = destPath + '.download';

    const { sha256, bytes, etag } = await downloadToFile(model.url, tempPath, {
        onProgress: progressReporter(model, onProgress),
        get,
    });
    try {
        verifySha256(extractSha256FromEtag(etag), sha256, model);
    } catch (error) {
        await fs.remove(tempPath);
        throw error;
    }

    await fs.move(tempPath, destPath, { overwrite: true });
    await writeModelMeta(model.filename, {
        sha256,
        sizeBytes: bytes,
        verifiedAt: new Date().toISOString(),
        sourceUrl: model.url,
        sourceEtag: etag || undefined,
    });
    onProgress?.(`Model ${model.name} ready`, 100);
    return destPath;
}

/**
 * Check HuggingFace for a newer model version (like antivirus signature updates).
 * Reads latest_version.json from the RLAIF dataset repo. Non-blocking — if the
 * check fails (offline, HF down), we silently use the cached/bundled version.
 *
 * Results are cached locally for 24 hours to avoid hammering HF on every run.
 */
export async function checkForUpdates(
    onProgress?: (message: string, percent?: number) => void
): Promise<string> {
    fs.ensureDirSync(MODELS_DIR);

    // Check local version cache first — avoid network on every run
    try {
        if (await fs.pathExists(VERSION_CACHE_PATH)) {
            const cached = await fs.readJson(VERSION_CACHE_PATH);
            const age = Date.now() - new Date(cached.checkedAt).getTime();
            if (age < VERSION_CHECK_INTERVAL_MS && cached.version) {
                const v = String(cached.version);
                updateModelVersion(v);
                return v;
            }
        }
    } catch {
        // Corrupted cache — proceed to network check
    }

    // Fetch latest version from HuggingFace (with timeout)
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), VERSION_CHECK_TIMEOUT_MS);

        const response = await fetch(VERSION_CHECK_URL, { signal: controller.signal });
        clearTimeout(timeout);

        if (response.ok) {
            const data = await response.json() as { version?: number | string; updated_by?: string };
            // Handle both legacy integer versions (5 → "5.0.0") and SemVer strings ("2.0.0")
            let rawVersion = data.version ?? BUNDLED_MODEL_VERSION;
            const latestVersion = typeof rawVersion === 'number'
                ? `${rawVersion}.0.0`
                : String(rawVersion);

            // Cache the result locally
            await fs.writeJson(VERSION_CACHE_PATH, {
                version: latestVersion,
                checkedAt: new Date().toISOString(),
                source: 'huggingface',
            }, { spaces: 2 }).catch(() => {});

            // Update in-memory model definitions
            updateModelVersion(latestVersion);

            if (latestVersion !== BUNDLED_MODEL_VERSION) {
                onProgress?.(`Model update available: v${latestVersion}`, 0);
            }
            return latestVersion;
        }
    } catch {
        // Offline / HF down / timeout — use bundled version silently
    }

    return BUNDLED_MODEL_VERSION;
}

/**
 * Download a model from HuggingFace CDN.
 * Checks for updates first, then tries fine-tuned model, falls back to stock Qwen.
 */
export async function downloadModel(
    tier: ModelTier,
    onProgress?: (message: string, percent?: number) => void,
    get?: HttpGet,
): Promise<string> {
    fs.ensureDirSync(MODELS_DIR);

    // Check for newer model version (non-blocking, cached 24h)
    await checkForUpdates(onProgress);

    const cached = await getCachedModel(tier);
    if (cached) {
        onProgress?.(`Model ${cached.info.name} already cached`, 100);
        return cached.path;
    }

    const model = MODELS[tier];
    onProgress?.(`Downloading ${model.name} (${model.sizeHuman})...`, 0);

    try {
        return await downloadFromUrl(model, onProgress, get);
    } catch (error: any) {
        const fallback = FALLBACK_MODELS[tier];
        if (fallback && fallback.url !== model.url) {
            onProgress?.(`Fine-tuned model unavailable (${error?.message ?? 'unknown error'}); using stock ${fallback.name}`, 0);
            return downloadFromUrl(fallback, onProgress, get);
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
    const cached = await getCachedModel(tier);
    if (cached) return cached.path;
    return downloadModel(tier, onProgress);
}

/**
 * Get the models directory path.
 */
export function getModelsDir(): string {
    return MODELS_DIR;
}
