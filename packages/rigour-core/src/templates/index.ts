/**
 * Templates — Public Barrel
 *
 * Re-exports from sub-modules so that existing importers keep working.
 * - Preset definitions  →  ./presets.ts
 * - Paradigm templates  →  ./paradigms.ts
 * - Universal config    →  ./universal-config.ts
 */

export type { Template } from './presets.js';
export { TEMPLATES } from './presets.js';
export { PARADIGM_TEMPLATES } from './paradigms.js';
export { UNIVERSAL_CONFIG } from './universal-config.js';
