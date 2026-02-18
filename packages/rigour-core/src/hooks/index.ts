/**
 * Hooks module — multi-tool hook integration for Rigour.
 *
 * @since v3.0.0
 */

export { runHookChecker } from './checker.js';
export { generateHookFiles } from './templates.js';
export type { HookTool, HookConfig, HookCheckerResult } from './types.js';
export { DEFAULT_HOOK_CONFIG, FAST_GATE_IDS } from './types.js';
