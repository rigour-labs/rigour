/**
 * Rigour Brain — SQLite storage layer.
 * Everything in one file: ~/.rigour/rigour.db
 */
export { openDatabase, isSQLiteAvailable, compactDatabase, getDatabaseSize, resetDatabase, RIGOUR_DIR, DB_PATH } from './db.js';
export type { RigourDB, CompactResult } from './db.js';
export { insertScan, getRecentScans, getScoreTrendFromDB, getTopIssues } from './scans.js';
export { insertFindings, getFindingsForScan, getDeepFindings } from './findings.js';
export { reinforcePattern, decayPatterns, getStrongPatterns, getPatterns, getHardRules } from './patterns.js';
export { checkLocalPatterns, persistAndReinforce, getProjectStats } from './local-memory.js';
export type { ProjectStats } from './local-memory.js';
export {
    recordContextEvent, recordModelUsage, setContextCacheRecord, getContextCacheRecord, recordCheckpointMetric,
    getContextEvents, getModelUsages, getCheckpointMetrics
} from './context-telemetry.js';
export type { ContextEvent, ModelUsage, ContextCacheRecord, CheckpointMetric } from './context-telemetry.js';
