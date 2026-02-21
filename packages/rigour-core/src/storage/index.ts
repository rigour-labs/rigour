/**
 * Rigour Brain — SQLite storage layer.
 * Everything in one file: ~/.rigour/rigour.db
 */
export { openDatabase, isSQLiteAvailable, RIGOUR_DIR, DB_PATH } from './db.js';
export type { RigourDB } from './db.js';
export { insertScan, getRecentScans, getScoreTrendFromDB, getTopIssues } from './scans.js';
export { insertFindings, getFindingsForScan, getDeepFindings } from './findings.js';
export { reinforcePattern, decayPatterns, getStrongPatterns, getPatterns, getHardRules } from './patterns.js';
