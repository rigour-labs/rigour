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
import { Logger } from '../utils/logger.js';

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

/** How far a file's write time may trail the verification time and still be the file that was verified. */
const MTIME_SLACK_MS = 2_000;

/**
 * Check if a single model file is cached and valid.
 */
async function isFileCached(model: ModelInfo): Promise<boolean> {
    const modelPath = path.join(MODELS_DIR, model.filename);
    if (!(await fs.pathExists(modelPath))) return false;
    const metadata = await readModelMeta(model.filename);
    if (!metadata) return false;
    // The metadata is written only after the checksum passed, so its exact size is
    // the completeness check; ModelInfo sizes are display estimates that differ by version.
    const stat = await fs.stat(modelPath);
    if (metadata.sizeBytes !== stat.size) return false;
    // A file changed after it was verified is not trusted. The two times come from different clocks: on Windows a
    // file's write time can land a few milliseconds after the Date taken just after writing it, so a file verified a
    // moment ago looked modified and was downloaded again on every run. Allow MTIME_SLACK_MS between them.
    if (new Date(metadata.verifiedAt).getTime() + MTIME_SLACK_MS < Math.floor(stat.mtimeMs)) return false;
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
 * Version cache format. Format 1 turned a published integer version into
 * SemVer ("5" -> "5.0.0"), which names repositories that were never published,
 * so those caches are ignored.
 */
const VERSION_CACHE_FORMAT = 2;
/** How long a failed fine-tuned download keeps the stock fallback before retrying. */
const FINE_TUNED_RETRY_MS = 24 * 60 * 60 * 1000;

/**
 * The version exactly as published. Integer versions (the RLAIF pipeline
 * before SemVer) are published as `v5`, SemVer versions as `v2.1.0`; either
 * way the string goes into the repository and file names unchanged.
 */
export function normalizeModelVersion(raw: unknown): string | null {
    if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) return String(raw);
    if (typeof raw !== 'string') return null;
    const value = raw.trim().replace(/^v/, '');
    return /^\d+$/.test(value) || /^\d+\.\d+\.\d+$/.test(value) ? value : null;
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
            const v = cached.format === VERSION_CACHE_FORMAT ? normalizeModelVersion(cached.version) : null;
            if (age < VERSION_CHECK_INTERVAL_MS && v) {
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
            const latestVersion = normalizeModelVersion(data.version) ?? BUNDLED_MODEL_VERSION;

            // Cache the result locally
            await fs.writeJson(VERSION_CACHE_PATH, {
                format: VERSION_CACHE_FORMAT,
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
    if (cached && !cached.fallback) {
        onProgress?.(`Model ${cached.info.name} already cached`, 100);
        return cached.path;
    }
    // Only the stock fallback is cached: try the fine-tuned model again, at most once a day,
    // so one failed download does not pin a user to the stock model forever.
    if (cached && !(await fineTunedRetryDue(tier))) return cached.path;

    const model = MODELS[tier];
    onProgress?.(`Downloading ${model.name} (${model.sizeHuman})...`, 0);

    try {
        const downloaded = await downloadFromUrl(model, onProgress, get);
        await fs.remove(retryMarker(tier)).catch(() => {});
        return downloaded;
    } catch (error: any) {
        const fallback = FALLBACK_MODELS[tier];
        if (!fallback || fallback.url === model.url) throw error;
        const reason = error?.message ?? 'unknown error';
        Logger.warn(`Fine-tuned model ${model.name} could not be downloaded from ${model.url} (${reason}); using the stock ${fallback.name}. Deep findings will be less accurate.`);
        onProgress?.(`Fine-tuned model unavailable (${reason}); using stock ${fallback.name}`, 0);
        await fs.writeJson(retryMarker(tier), { failedAt: new Date().toISOString(), url: model.url, reason }).catch(() => {});
        return cached?.path ?? downloadFromUrl(fallback, onProgress, get);
    }
}

function retryMarker(tier: ModelTier): string {
    return path.join(MODELS_DIR, `.fine-tuned-unavailable-${tier}.json`);
}

async function fineTunedRetryDue(tier: ModelTier): Promise<boolean> {
    try {
        const marker = await fs.readJson(retryMarker(tier));
        return Date.now() - new Date(marker.failedAt).getTime() >= FINE_TUNED_RETRY_MS || marker.url !== MODELS[tier].url;
    } catch {
        return true;
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
