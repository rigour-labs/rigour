export * from './types/index.js';
export * from './gates/runner.js';
export * from './discovery.js';
export * from './services/fix-packet-service.js';
export * from './templates/index.js';
export * from './types/fix-packet.js';
export { Gate, GateContext } from './gates/base.js';
export { RetryLoopBreakerGate } from './gates/retry-loop-breaker.js';
export * from './utils/logger.js';
export * from './services/score-history.js';
export * from './hooks/index.js';
// Settings Module (Global user config at ~/.rigour/settings.json)
export { loadSettings, saveSettings, getSettingsPath, resolveDeepOptions, getProviderKey, getAgentConfig, getCliPreferences, updateProviderKey, removeProviderKey } from './settings.js';
export type { RigourSettings, ResolvedDeepOptions, CLIDeepOptions } from './settings.js';
// Deep Analysis Pipeline (v4.0+)
export { DeepAnalysisGate } from './gates/deep-analysis.js';
export { createProvider } from './inference/index.js';
export type { InferenceProvider, DeepFinding, DeepAnalysisResult, ModelTier } from './inference/types.js';
export { MODELS } from './inference/types.js';
export { isModelCached, getModelsDir, getModelInfo } from './inference/model-manager.js';
export { extractFacts, factsToPromptString } from './deep/fact-extractor.js';
// Storage (SQLite Brain)
export { openDatabase, isSQLiteAvailable, insertScan, insertFindings, getRecentScans, getScoreTrendFromDB, getTopIssues, reinforcePattern, getStrongPatterns } from './storage/index.js';
export type { RigourDB } from './storage/index.js';
// Pattern Index is intentionally NOT exported here to prevent
// native dependency issues (sharp/transformers) from leaking into
// non-AI parts of the system.
// Import from @rigour-labs/core/pattern-index instead.
