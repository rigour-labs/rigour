/**
 * Rule data for deprecated-apis gate.
 * Node.js and Web API deprecation rules extracted to keep deprecated-apis.ts under 500 lines.
 */

export interface DeprecatedRule {
    pattern: RegExp;
    api: string;
    reason: string;
    replacement: string;
    category: 'security' | 'removed' | 'superseded';
}

/**
 * Node.js deprecated APIs — sourced from official Node.js deprecation list
 */
export const NODE_DEPRECATED_RULES: DeprecatedRule[] = [
    // Security-deprecated
    {
        pattern: /new\s+Buffer\s*\(/,
        api: 'new Buffer()',
        reason: 'DEP0005: Security vulnerability — uninitialized memory exposure',
        replacement: 'Buffer.from(), Buffer.alloc(), or Buffer.allocUnsafe()',
        category: 'security',
    },
    {
        pattern: /Buffer\s*\(\s*(?:\d|['"])/,
        api: 'Buffer() constructor',
        reason: 'DEP0005: Security vulnerability — uninitialized memory exposure',
        replacement: 'Buffer.from(), Buffer.alloc(), or Buffer.allocUnsafe()',
        category: 'security',
    },
    {
        pattern: /createCipher\s*\(/,
        api: 'crypto.createCipher()',
        reason: 'DEP0106: Uses weak key derivation (no IV, no salt)',
        replacement: 'crypto.createCipheriv() with explicit IV',
        category: 'security',
    },
    {
        pattern: /createDecipher\s*\(/,
        api: 'crypto.createDecipher()',
        reason: 'DEP0106: Uses weak key derivation (no IV, no salt)',
        replacement: 'crypto.createDecipheriv() with explicit IV',
        category: 'security',
    },
    // Removed
    {
        pattern: /\brequire\s*\(\s*['"]domain['"]\s*\)/,
        api: "require('domain')",
        reason: 'DEP0032: domain module is deprecated (error handling issues)',
        replacement: 'async_hooks, try/catch, or Promise error handling',
        category: 'removed',
    },
    {
        pattern: /\brequire\s*\(\s*['"]punycode['"]\s*\)/,
        api: "require('punycode')",
        reason: 'DEP0040: punycode module removed from Node.js core',
        replacement: 'npm package: punycode (userland)',
        category: 'removed',
    },
    {
        pattern: /\brequire\s*\(\s*['"]sys['"]\s*\)/,
        api: "require('sys')",
        reason: 'DEP0025: sys module was renamed to util',
        replacement: "require('util')",
        category: 'removed',
    },
    {
        pattern: /\brequire\s*\(\s*['"]_linklist['"]\s*\)/,
        api: "require('_linklist')",
        reason: 'DEP0037: _linklist module removed',
        replacement: 'npm userland linked list package',
        category: 'removed',
    },
    // Superseded
    {
        pattern: /url\.parse\s*\(/,
        api: 'url.parse()',
        reason: 'DEP0169: Legacy URL parser has known vulnerabilities',
        replacement: 'new URL() (WHATWG URL API)',
        category: 'superseded',
    },
    {
        pattern: /url\.resolve\s*\(/,
        api: 'url.resolve()',
        reason: 'DEP0169: Legacy URL API',
        replacement: 'new URL(relative, base)',
        category: 'superseded',
    },
    {
        pattern: /url\.format\s*\(\s*(?:url\.parse|{)/,
        api: 'url.format(urlObject)',
        reason: 'DEP0169: Legacy URL API with url.parse objects',
        replacement: 'new URL().toString() or url.format(new URL(...))',
        category: 'superseded',
    },
    {
        pattern: /\.send\s*\(\s*new\s+Buffer\b/,
        api: 'Sending raw Buffer',
        reason: 'Potential uninitialized memory leak when Buffer() used without alloc',
        replacement: 'Buffer.from() or Buffer.alloc()',
        category: 'security',
    },
    {
        pattern: /fs\.exists\s*\(/,
        api: 'fs.exists()',
        reason: 'DEP0103: fs.exists() is deprecated (race condition issues)',
        replacement: 'fs.access() or fs.stat()',
        category: 'superseded',
    },
    {
        pattern: /util\.inherits\s*\(/,
        api: 'util.inherits()',
        reason: 'DEP0: Superseded by ES6 class extends',
        replacement: 'class Child extends Parent {}',
        category: 'superseded',
    },
    {
        pattern: /util\.pump\s*\(/,
        api: 'util.pump()',
        reason: 'DEP0004: Removed — use stream.pipeline()',
        replacement: 'stream.pipeline() or pipe()',
        category: 'removed',
    },
    {
        pattern: /util\.puts\s*\(|util\.print\s*\(|util\.debug\s*\(/,
        api: 'util.puts/print/debug()',
        reason: 'DEP0027/28/29: Removed console wrappers',
        replacement: 'console.log() / console.error()',
        category: 'removed',
    },
    {
        pattern: /SlowBuffer\s*\(/,
        api: 'SlowBuffer',
        reason: 'DEP0030: Deprecated class',
        replacement: 'Buffer.allocUnsafeSlow()',
        category: 'superseded',
    },
    {
        pattern: /\.setEncoding\s*\(\s*['"]binary['"]\s*\)/,
        api: "setEncoding('binary')",
        reason: "DEP0040: 'binary' encoding is deprecated",
        replacement: "'latin1' encoding",
        category: 'superseded',
    },
    {
        pattern: /process\.(?:assert|binding)\s*\(/,
        api: 'process.assert()/binding()',
        reason: 'DEP0064/0098: Internal APIs removed',
        replacement: 'assert module / public APIs',
        category: 'removed',
    },
];

/**
 * Web API deprecated patterns
 */
export const WEB_DEPRECATED_RULES: DeprecatedRule[] = [
    {
        pattern: /document\.write\s*\(/,
        api: 'document.write()',
        reason: 'Blocks parsing, security risk (XSS vector), removed in strict mode',
        replacement: 'DOM manipulation (createElement, appendChild, innerHTML)',
        category: 'security',
    },
    {
        pattern: /\.innerHTML\s*=\s*[`'"]/,
        api: 'innerHTML assignment with strings',
        reason: 'XSS vulnerability when used with user-supplied content',
        replacement: 'textContent, createElement + appendChild, or DOMPurify.sanitize()',
        category: 'security',
    },
    {
        pattern: /eval\s*\(\s*[^)]/,
        api: 'eval()',
        reason: 'Code injection vulnerability, prevents optimization',
        replacement: 'JSON.parse(), Function constructor (if absolutely needed), or structured approach',
        category: 'security',
    },
    {
        pattern: /with\s*\(\s*\w/,
        api: 'with statement',
        reason: 'Removed in strict mode, creates ambiguous scope, security risk',
        replacement: 'Destructuring or explicit property access',
        category: 'removed',
    },
    {
        pattern: /document\.all\b/,
        api: 'document.all',
        reason: 'Legacy IE API, falsy object (quirks mode artifact)',
        replacement: 'document.getElementById(), document.querySelector()',
        category: 'superseded',
    },
    {
        pattern: /escape\s*\(\s*['"]/,
        api: 'escape()',
        reason: 'Deprecated — does not handle Unicode correctly',
        replacement: 'encodeURIComponent() or encodeURI()',
        category: 'superseded',
    },
    {
        pattern: /unescape\s*\(/,
        api: 'unescape()',
        reason: 'Deprecated — does not handle Unicode correctly',
        replacement: 'decodeURIComponent() or decodeURI()',
        category: 'superseded',
    },
];
