/**
 * Hooks module — multi-tool hook integration for Rigour.
 *
 * @since v3.0.0
 * @since v4.2.0 — AI Agent DLP (Data Loss Prevention)
 */

export { runHookChecker } from './checker.js';
export { generateHookFiles } from './templates.js';
export type { HookTool, HookConfig, HookCheckerResult } from './types.js';
export { DEFAULT_HOOK_CONFIG, FAST_GATE_IDS } from './types.js';

// DLP (Data Loss Prevention) — v4.2.0
export { scanInputForCredentials, formatDLPAlert, createDLPAuditEntry } from './input-validator.js';
export type { CredentialDetection, InputValidationResult, InputValidationConfig } from './input-validator.js';
export { generateDLPHookFiles } from './dlp-templates.js';
export type { GeneratedDLPHookFile } from './dlp-templates.js';
