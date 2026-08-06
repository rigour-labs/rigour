/**
 * Hooks module — multi-tool hook integration for Rigour.
 *
 */

export { runHookChecker } from './checker.js';
export { generateHookFiles } from './templates.js';
export type { HookTool, HookConfig, HookCheckerResult } from './types.js';
export { DEFAULT_HOOK_CONFIG, FAST_GATE_IDS } from './types.js';

// DLP (Data Loss Prevention) — v4.2.0
export { scanInputForCredentials, formatDLPAlert, createDLPAuditEntry } from './input-validator.js';
export type { CredentialDetection, InputValidationResult, InputValidationConfig } from './input-validator.js';
export {
    recordDLPFeedback,
    allowLastDLPBlock,
    writeDLPBlockManifest,
    getLearnedAllowCount,
    loadDLPFeedbackStore,
    loadDLPFeedbackStoreSync,
    fingerprintDetection,
} from './dlp-feedback.js';
export type { DLPFeedbackEntry, DLPFeedbackStore, DLPBlockManifest } from './dlp-feedback.js';
export { generateDLPHookFiles } from './dlp-templates.js';
export type { GeneratedDLPHookFile } from './dlp-templates.js';
