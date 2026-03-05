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
 * - lite: Qwen3.5-0.8B fine-tuned — lightweight, ships as default CLI sidecar
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
 * Model version — bump when new fine-tuned GGUF is published.
 * The RLAIF pipeline uploads new models to HuggingFace, and
 * model-manager checks this version to auto-update.
 */
export const MODEL_VERSION = '1';

/** All supported model definitions */
export const MODELS: Record<ModelTier, ModelInfo> = {
    deep: {
        tier: 'deep',
        name: 'Rigour-Deep-v1 (Qwen2.5-Coder-1.5B fine-tuned)',
        filename: `rigour-deep-v${MODEL_VERSION}-q4_k_m.gguf`,
        url: `https://huggingface.co/rigour-labs/rigour-deep-v1-gguf/resolve/main/rigour-deep-v${MODEL_VERSION}-q4_k_m.gguf`,
        sizeBytes: 900_000_000,
        sizeHuman: '900MB',
    },
    lite: {
        tier: 'lite',
        name: 'Rigour-Lite-v1 (Qwen3.5-0.8B fine-tuned)',
        filename: `rigour-lite-v${MODEL_VERSION}-q4_k_m.gguf`,
        url: `https://huggingface.co/rigour-labs/rigour-lite-v1-gguf/resolve/main/rigour-lite-v${MODEL_VERSION}-q4_k_m.gguf`,
        sizeBytes: 500_000_000,
        sizeHuman: '500MB',
    },
    legacy: {
        tier: 'legacy',
        name: 'Rigour-Legacy-v1 (Qwen2.5-Coder-0.5B fine-tuned)',
        filename: `rigour-legacy-v${MODEL_VERSION}-q4_k_m.gguf`,
        url: `https://huggingface.co/rigour-labs/rigour-legacy-v1-gguf/resolve/main/rigour-legacy-v${MODEL_VERSION}-q4_k_m.gguf`,
        sizeBytes: 350_000_000,
        sizeHuman: '350MB',
    },
};

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
        name: 'Qwen3.5-0.8B (stock)',
        filename: 'qwen3.5-0.8b-q4_k_m.gguf',
        url: 'https://huggingface.co/Qwen/Qwen3.5-0.8B-GGUF/resolve/main/qwen3.5-0.8b-q4_k_m.gguf',
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
