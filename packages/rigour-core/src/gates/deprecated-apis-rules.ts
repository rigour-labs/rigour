/**
 * Barrel file: re-exports all deprecated API rules.
 * Individual rules extracted to separate files for maintainability.
 */

export { DeprecatedRule, NODE_DEPRECATED_RULES, WEB_DEPRECATED_RULES } from './deprecated-apis-rules-node.js';
export { PYTHON_DEPRECATED_RULES, GO_DEPRECATED_RULES, CSHARP_DEPRECATED_RULES, JAVA_DEPRECATED_RULES } from './deprecated-apis-rules-lang.js';
