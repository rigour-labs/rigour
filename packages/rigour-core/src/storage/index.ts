/**
 * Rigour Brain — SQLite storage layer.
 * Everything in one file: ~/.rigour/rigour.db
 */
export { openDatabase, isSQLiteAvailable, compactDatabase, getDatabaseSize, resetDatabase, RIGOUR_DIR, DB_PATH } from './db.js';
export { cleanContextCache, deadCacheRows, DEAD_CACHE_TYPES, type CacheCleanupReport } from './cache-cleanup.js';
export type { RigourDB, CompactResult } from './db.js';
export { insertScan, getRecentScans, getScoreTrendFromDB, getTopIssues } from './scans.js';
export { insertFindings, getFindingsForScan, getDeepFindings } from './findings.js';
export { reinforcePattern, decayPatterns, getStrongPatterns, getPatterns, getHardRules } from './patterns.js';
export { checkLocalPatterns, persistAndReinforce, getProjectStats } from './local-memory.js';
export type { ProjectStats } from './local-memory.js';
export {
    recordContextEvent, recordModelUsage, setContextCacheRecord, getContextCacheRecord, listContextCacheRecords,
    recordCheckpointMetric, getContextEvents, getModelUsages, getCheckpointMetrics
} from './context-telemetry.js';
export type { ContextEvent, ModelUsage, ContextCacheRecord, CheckpointMetric } from './context-telemetry.js';
export { recordFixLessons, fixLessonSubject, fixLessonPrefix, FILES_TO_VALIDATE } from './fix-lessons.js';
export { recordInteractionEvidence, countInteractionEvidence, listLessons, listKnowledgeLessons, getApplicableLessons, transitionLesson, getRepositoryId, shareMemoryLesson } from './lessons.js';
export type { ApplicableLessons, InteractionEvidence, LessonRecord, LessonState, LessonVisibility } from './lessons.js';
export { queueLocalLessonsForTeam } from './team-import.js';
export type { LocalLessonImportOptions, LocalLessonImportResult } from './team-import.js';
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
} from './team-store.js';
export { explainTeamConnectionError } from './team-diagnostics.js';
export type {
    TeamConfiguration, TeamSemanticConfiguration, TeamModeStatus, TeamDoctorResult,
    SemanticKnowledgeCandidate, SemanticKnowledgeResult,
} from './team-store.js';
