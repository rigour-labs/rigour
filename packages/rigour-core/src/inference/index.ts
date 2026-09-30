/**
 * Inference provider factory and exports.
 */
export type { InferenceProvider, InferenceOptions, DeepFinding, DeepAnalysisResult, ModelTier, ModelInfo } from './types.js';
export { MODELS } from './types.js';
export { SidecarProvider } from './sidecar-provider.js';
export type { ActiveModel } from './sidecar-provider.js';
export { installLlamaEngine, probeBinary, managedEnginePath, LLAMA_RELEASE_TAG } from './llama-engine.js';
export type { ProbeResult } from './llama-engine.js';
export { CloudProvider } from './cloud-provider.js';
export { ensureModel, isModelCached, getModelPath, getModelInfo, downloadModel, getModelsDir, getCachedModel } from './model-manager.js';
export type { CachedModel } from './model-manager.js';

import { localTier, type InferenceProvider } from './types.js';
import type { DeepOptions } from '../types/index.js';
import { SidecarProvider } from './sidecar-provider.js';
import { CloudProvider } from './cloud-provider.js';

/**
 * Create the appropriate inference provider based on options.
 *
 * - No API key → SidecarProvider (local llama.cpp binary)
 * - API key + any provider → CloudProvider (no restrictions, user's key, user's choice)
 */
export function createProvider(options: DeepOptions): InferenceProvider {
    if (options.apiKey && options.provider && options.provider !== 'local') {
        return new CloudProvider(options.provider, options.apiKey, {
            baseUrl: options.apiBaseUrl,
            modelName: options.modelName,
        });
    }

    // Default: local sidecar (lite 0.5B, deep 1.5B with --pro, max 7B with --max)
    return new SidecarProvider(localTier(options), undefined, options.modelPath);
}
