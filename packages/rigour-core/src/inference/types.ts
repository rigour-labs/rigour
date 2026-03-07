/**
 * Inference provider interface for Rigour deep analysis.
 * Supports sidecar binary (local llama.cpp), cloud APIs (Claude/OpenAI).
 */
import type { Severity } from '../types/index.js';

/**
 * Abstract inference provider — all backends implement this.
 */
export interface InferenceProvider {
    /** Provider name for logging/reporting */
    readonly name: string;

    /** Check if this provider is available (binary exists, API key valid, etc.) */
    isAvailable(): Promise<boolean>;

    /**
     * One-time setup: download model, verify binary, etc.
     * Should show progress to user via callback.
     */
    setup(onProgress?: (message: string) => void): Promise<void>;

    /**
     * Run inference on a prompt. Returns raw text response.
     * Provider handles tokenization, temperature, etc.
     */
    analyze(prompt: string, options?: InferenceOptions): Promise<string>;

    /** Clean up resources (kill process, close connection) */
    dispose(): void;
}

export interface InferenceOptions {
    maxTokens?: number;
    temperature?: number;
    timeout?: number;
    jsonMode?: boolean;
}

/**
 * A single finding from deep LLM analysis.
 */
export interface DeepFinding {
    /** Category like 'srp_violation', 'god_function', 'dry_violation' */
    category: string;
    /** Severity level */
    severity: Severity;
    /** Relative file path */
    file: string;
    /** Line number (if available) */
    line?: number;
    /** Human-readable description of the issue */
    description: string;
    /** Actionable suggestion for how to fix */
    suggestion: string;
    /** LLM confidence score 0.0-1.0 */
    confidence: number;
}

/**
 * Result of a deep analysis batch.
 */
export interface DeepAnalysisResult {
    findings: DeepFinding[];
    model: string;
    tokensUsed?: number;
    durationMs: number;
}

/**
 * Available model tiers.
 *
 * - deep: Qwen2.5-Coder-1.5B fine-tuned — full power, company-hosted
 * - lite: Qwen2.5-Coder-0.5B fine-tuned — lightweight, ships as default CLI sidecar
 * - legacy: Qwen2.5-Coder-0.5B fine-tuned — previous default, reproducibility
 */
export type ModelTier = 'deep' | 'lite' | 'legacy';

/**
 * Model info for download/caching.
 */
export interface ModelInfo {
    tier: ModelTier;
    name: string;
    filename: string;
    url: string;
    sizeBytes: number;    // approximate size in bytes
    sizeHuman: string;    // e.g. "350MB"
}

/**
 * Minimum bundled model version — used as fallback when the auto-update
 * check fails (offline, HF down, first run). The RLAIF training pipeline
 * publishes new versions to HuggingFace and updates latest_version.json.
 * At startup, model-manager checks HF for the latest version and downloads
 * it automatically (like antivirus signature updates).
 *
 * Version format: SemVer (MAJOR.MINOR.PATCH)
 *   - MAJOR: Training data format change, base model change, pipeline architecture
 *   - MINOR: New training repos, updated dataset, hyperparameter improvements
 *   - PATCH: Bug fixes, retraining with same data/format
 */
export const BUNDLED_MODEL_VERSION = '2.0.0';

/** HuggingFace dataset repo where latest_version.json lives */
export const VERSION_CHECK_URL =
    'https://huggingface.co/datasets/rigour-labs/rigour-rlaif-data/resolve/main/latest_version.json';

/** Build model info for a given tier and version */
export function buildModelInfo(tier: ModelTier, version: string): ModelInfo {
    const meta: Record<ModelTier, { base: string; size: number; sizeH: string }> = {
        deep:   { base: 'Qwen2.5-Coder-1.5B',     size: 900_000_000, sizeH: '900MB' },
        lite:   { base: 'Qwen2.5-Coder-0.5B',      size: 500_000_000, sizeH: '500MB' },
        legacy: { base: 'Qwen2.5-Coder-0.5B',      size: 350_000_000, sizeH: '350MB' },
    };
    const m = meta[tier];
    return {
        tier,
        name: `Rigour-${tier[0].toUpperCase() + tier.slice(1)}-v${version} (${m.base} fine-tuned)`,
        filename: `rigour-${tier}-v${version}-q4_k_m.gguf`,
        url: `https://huggingface.co/rigour-labs/rigour-${tier}-v${version}-gguf/resolve/main/rigour-${tier}-v${version}-q4_k_m.gguf`,
        sizeBytes: m.size,
        sizeHuman: m.sizeH,
    };
}

/** Current model definitions — initialized with bundled version, updated at runtime */
export const MODELS: Record<ModelTier, ModelInfo> = {
    deep:   buildModelInfo('deep', BUNDLED_MODEL_VERSION),
    lite:   buildModelInfo('lite', BUNDLED_MODEL_VERSION),
    legacy: buildModelInfo('legacy', BUNDLED_MODEL_VERSION),
};

/**
 * Update MODELS in-place to point to a newer version.
 * Called by model-manager after checking latest_version.json.
 */
export function updateModelVersion(version: string): void {
    for (const tier of ['deep', 'lite', 'legacy'] as ModelTier[]) {
        const updated = buildModelInfo(tier, version);
        MODELS[tier] = updated;
    }
}

/**
 * Fallback stock models — used when fine-tuned model is not yet
 * available on HuggingFace (initial setup / first-time users).
 */
export const FALLBACK_MODELS: Record<ModelTier, ModelInfo> = {
    deep: {
        tier: 'deep',
        name: 'Qwen2.5-Coder-1.5B-Instruct (stock)',
        filename: 'qwen2.5-coder-1.5b-instruct-q4_k_m.gguf',
        url: 'https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF/resolve/main/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf',
        sizeBytes: 900_000_000,
        sizeHuman: '900MB',
    },
    lite: {
        tier: 'lite',
        name: 'Qwen2.5-Coder-0.5B-Instruct (stock)',
        filename: 'qwen2.5-coder-0.5b-instruct-q4_k_m.gguf',
        url: 'https://huggingface.co/Qwen/Qwen2.5-Coder-0.5B-Instruct-GGUF/resolve/main/qwen2.5-coder-0.5b-instruct-q4_k_m.gguf',
        sizeBytes: 500_000_000,
        sizeHuman: '500MB',
    },
    legacy: {
        tier: 'legacy',
        name: 'Qwen2.5-Coder-0.5B-Instruct (stock)',
        filename: 'qwen2.5-coder-0.5b-instruct-q4_k_m.gguf',
        url: 'https://huggingface.co/Qwen/Qwen2.5-Coder-0.5B-Instruct-GGUF/resolve/main/qwen2.5-coder-0.5b-instruct-q4_k_m.gguf',
        sizeBytes: 350_000_000,
        sizeHuman: '350MB',
    },
};
