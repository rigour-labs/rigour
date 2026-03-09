/**
 * Language Adapters — Barrel Export
 *
 * Single entry point for the language adapter layer.
 * Gates import from here: `import { languageAdapters } from './language-adapters/index.js'`
 */

export * from './types.js';
export * from './registry.js';

// Individual adapters (for direct use if needed)
export { jsAdapter } from './js-adapter.js';
export { pythonAdapter } from './python-adapter.js';
export { goAdapter } from './go-adapter.js';
export { rubyAdapter } from './ruby-adapter.js';
export { rustAdapter } from './rust-adapter.js';
export { csharpAdapter } from './csharp-adapter.js';
export { javaAdapter } from './java-adapter.js';
