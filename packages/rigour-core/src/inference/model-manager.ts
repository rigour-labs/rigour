/**
 * Model Manager — handles downloading, caching, and verifying GGUF models.
 * Models cached at ~/.rigour/models/
 */
import path from 'path';
import fs from 'fs-extra';
import { RIGOUR_DIR } from '../storage/db.js';
import { MODELS, type ModelTier, type ModelInfo } from './types.js';

const MODELS_DIR = path.join(RIGOUR_DIR, 'models');

/**
 * Check if a model is already downloaded and valid.
 */
export function isModelCached(tier: ModelTier): boolean {
    const model = MODELS[tier];
    const modelPath = path.join(MODELS_DIR, model.filename);
    if (!fs.existsSync(modelPath)) return false;

    // Basic size check (within 10% tolerance)
    const stat = fs.statSync(modelPath);
    const tolerance = model.sizeBytes * 0.1;
    return stat.size > model.sizeBytes - tolerance;
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
    if (isModelCached(tier)) {
        onProgress?.(`Model ${model.name} already cached`, 100);
        return destPath;
    }

    onProgress?.(`Downloading ${model.name} (${model.sizeHuman})...`, 0);

    try {
        const response = await fetch(model.url);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const contentLength = parseInt(response.headers.get('content-length') || '0', 10);
        const reader = response.body?.getReader();
        if (!reader) throw new Error('No response body');

        const writeStream = fs.createWriteStream(tempPath);
        let downloaded = 0;
        let lastProgressPercent = 0;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            writeStream.write(Buffer.from(value));
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

        // Atomic rename
        fs.renameSync(tempPath, destPath);
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
    if (isModelCached(tier)) {
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
