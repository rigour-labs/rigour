export * from './types/index.js';
export * from './gates/runner.js';
export * from './discovery.js';
export * from './services/fix-packet-service.js';
export * from './templates/index.js';
export * from './types/fix-packet.js';
export { Gate, GateContext } from './gates/base.js';
export { RetryLoopBreakerGate } from './gates/retry-loop-breaker.js';
export { SideEffectAnalysisGate } from './gates/side-effect-analysis/index.js';
export { FrontendSecretExposureGate } from './gates/frontend-secret-exposure.js';
export * from './utils/logger.js';
export { normalizeScopePatterns, isScoped } from './utils/scope.js';
export { deepAnalysisError } from './utils/deep-status.js';
export { reviewChange, toReviewFinding, type ReviewInput, type ReviewResult, type ReviewFinding } from './review/review.js';
export { splitByChangedLines, type ChangedLineSplit } from './review/changed-lines.js';
export { diffFromGit, GitDiffError, type DiffSource } from './review/git-diff.js';
export { recordReviewOutcome, listResolvedFixes, removeResolvedFix, openFindingCount, type ResolvedFix, type FixCapture } from './review/agent-fixes.js';
export { computeEffectiveness, readAgentEvents, appendAgentEvent, findingKeys, type AgentEvent, type ReviewEffectiveness } from './review/effectiveness.js';
export { parseDiff, changedLinesByFile } from './utils/diff.js';
export { FileScanner } from './utils/scanner.js';
export * from './services/score-history.js';
export * from './hooks/index.js';
// Settings Module (Global user config at ~/.rigour/settings.json)
export {
  loadSettings,
  saveSettings,
  getSettingsPath,
  resolveDeepOptions,
  getProviderKey,
  getAgentConfig,
  getCliPreferences,
  updateProviderKey,
  removeProviderKey,
  getCursorApiKey,
  isCursorApiKeyConfigured,
  getCursorApiKeyHint,
  updateCursorApiKey,
  removeCursorApiKey,
} from './settings.js';
export type { RigourSettings, ResolvedDeepOptions, CLIDeepOptions } from './settings.js';
// Deep Analysis Pipeline (v4.0+)
export { DeepAnalysisGate } from './gates/deep-analysis.js';
export { createProvider } from './inference/index.js';
export type { InferenceProvider, DeepFinding, DeepAnalysisResult, ModelTier } from './inference/types.js';
export { MODELS, localTier } from './inference/types.js';
export { isModelCached, getModelsDir, getModelInfo, getCachedModel, ensureModel } from './inference/model-manager.js';
export { installLlamaEngine, probeBinary, managedEnginePath, LLAMA_RELEASE_TAG } from './inference/llama-engine.js';
export { SidecarProvider } from './inference/sidecar-provider.js';
export { extractFacts, factsToPromptString } from './deep/fact-extractor.js';
// Storage (SQLite Brain)
export { openDatabase, isSQLiteAvailable, compactDatabase, getDatabaseSize, resetDatabase, insertScan, insertFindings, getRecentScans, getScoreTrendFromDB, getTopIssues, reinforcePattern, getStrongPatterns } from './storage/index.js';
export type { RigourDB, CompactResult } from './storage/index.js';
// Local Project Memory (hybrid intelligence — SQLite-backed per-project learning)
export { checkLocalPatterns, persistAndReinforce, getProjectStats } from './storage/index.js';
export type { ProjectStats } from './storage/index.js';
export { recordInteractionEvidence, countInteractionEvidence, recordInteractionLesson, listLessons, listKnowledgeLessons, getApplicableLessons, transitionLesson, getRepositoryId, queueLocalLessonsForTeam } from './storage/index.js';
export type { ApplicableLessons, InteractionEvidence, LessonRecord, LessonState, LessonVisibility, LocalLessonImportOptions, LocalLessonImportResult } from './storage/index.js';
export {
  loadTeamConfiguration,
  saveTeamConfiguration,
  initializeTeamSchema,
  getTeamModeStatus,
  doctorTeamConnection,
  syncTeamOutbox,
  searchTeamKnowledge,
  backfillTeamEmbeddings,
  TEAM_CONFIG_PATH,
  validateTeamDatabaseUrl,
  explainTeamConnectionError,
} from './storage/index.js';
export type {
  TeamConfiguration, TeamSemanticConfiguration, TeamModeStatus, TeamDoctorResult,
  SemanticKnowledgeCandidate, SemanticKnowledgeResult,
} from './storage/index.js';
// Temporal Drift Engine (v5 — cross-session trend analysis + per-provenance EWMA)
export { generateTemporalDriftReport, formatDriftSummary } from './services/temporal-drift.js';
export type { TemporalDriftReport, ProvenanceStream, MonthlyBucket, WeeklyBucket, DriftDirection } from './services/temporal-drift.js';
// Adaptive Thresholds (v5 — Z-score + per-provenance trends)
export { getProvenanceTrends, getQualityTrend } from './services/adaptive-thresholds.js';
export type { ProvenanceTrends, ProvenanceRunData } from './services/adaptive-thresholds.js';
// Incremental Cache (cross-run file change detection)
export { IncrementalCache } from './services/incremental-cache.js';
export type { IncrementalResult } from './services/incremental-cache.js';
// Terminal Renderer (rich CLI/MCP output)
export { renderScoreGauge, renderSeveritySection, renderGateGrid, renderBrainStatus, renderFullReport, renderMcpHeadline, renderFixAttribution } from './services/terminal-renderer.js';
export type { RenderOptions, GateResult } from './services/terminal-renderer.js';
// Context Telemetry & 4-Layer Caching Engine
export * from './context/cache-engine.js';
export * from './context/context-session.js';
export * from './context/index-bridge.js';
export * from './context/automatic-index.js';
export * from './context/dependency-graph.js';
export * from './services/context-telemetry-service.js';
export * from './services/observed-savings.js';
export * from './services/system-health.js';
export * from './services/agent-history.js';
export * from './services/engineering-knowledge-graph.js';

export * from './firewall/index.js';
export { exportCallSites } from './semantic/sites/export.js';
export { ALL_RULES, analyzeFiles, BUILT_IN_RULES } from './semantic/engine.js';
export { exportReviewContexts, type ReviewContextExport, type ReviewContextOptions } from './deep/review-context-export.js';
export type { CallSite, HandledBy } from './semantic/sites/call-sites.js';
export { learnFromFix, learnFromFileChange, type LearnReport, type Rejection } from './semantic/learn/learn.js';
export { extractFixTrees, type FixTrees } from './semantic/learn/git-trees.js';
export { saveLearnedRule, loadLearnedRules, LEARNED_RULES_DIR } from './semantic/learn/store.js';
export type { LearnedRule, LearnedPattern } from './semantic/learn/types.js';
export {
    recordContextEvent,
    recordModelUsage,
    recordCheckpointMetric,
    getContextEvents,
    getModelUsages,
    getCheckpointMetrics,
} from './storage/index.js';
// Pattern Index is intentionally NOT exported here to prevent
// native dependency issues (sharp/transformers) from leaking into
// non-AI parts of the system.
// Import from @rigour-labs/core/pattern-index instead.

// Types named by the exported signatures above, so consumers can annotate what they pass and receive.
export type { ModelInfo } from './inference/types.js';
export type { HttpGet } from './inference/http-download.js';
export type { FileFacts } from './deep/fact-extractor.js';
export type { ScanRecord } from './storage/scans.js';
export type { QualityTrend } from './services/adaptive-thresholds.js';
export type { EngineOptions } from './semantic/engine.js';
export type { LearnInput } from './semantic/learn/learn.js';
export type { ContextEvent } from './storage/index.js';
export type { CachedModel } from './inference/model-manager.js';
export type { ProbeResult } from './inference/llama-engine.js';
export type { PatternRecord } from './storage/patterns.js';
export type { SemanticFinding } from './semantic/types.js';
export type { ModelUsage } from './storage/index.js';
export type { CheckpointMetric } from './storage/index.js';
export type { CursorUsageSyncOptions } from './services/cursor-usage-client.js';
