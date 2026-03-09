/**
 * Dependency Guardian Gate (v2)
 *
 * Detects dependency issues that AI agents commonly introduce:
 * 1. Forbidden dependencies (existing) — packages banned by project standards
 * 2. Unused dependencies (NEW) — installed but never imported
 * 3. Heavy alternatives (NEW) — bloated packages with lighter alternatives
 * 4. Duplicate purpose (NEW) — multiple packages solving the same problem
 *
 * AI agents are particularly prone to:
 * - Adding packages they've seen in training data without checking existing deps
 * - Using heavy/popular packages when lighter alternatives exist
 * - Installing multiple HTTP clients, date libs, etc. across different sessions
 *
 */

import fs from 'fs-extra';
import path from 'path';
import { Failure, Config } from '../types/index.js';
import { Gate, GateContext } from './base.js';
import { FileScanner } from '../utils/scanner.js';
import { Logger } from '../utils/logger.js';

/**
 * Known heavy packages with lighter alternatives.
 * Format: package → "alternative (size comparison)"
 */
const HEAVY_ALTERNATIVES: Record<string, string> = {
    'moment': 'date-fns or dayjs (67KB → 2KB gzipped)',
    'lodash': 'lodash-es (tree-shakeable) or native Array/Object methods',
    'underscore': 'native ES6+ methods (Array.map, Object.entries, etc.)',
    'axios': 'native fetch API (built into Node 18+)',
    'request': 'got, undici, or native fetch (request deprecated since 2020)',
    'bluebird': 'native Promise (built-in since ES2015)',
    'jquery': 'native DOM APIs (querySelector, fetch, classList)',
    'classnames': 'clsx (0.3KB vs 1KB) or template literals',
    'uuid': 'crypto.randomUUID() (built into Node 19+ and browsers)',
    'left-pad': 'String.prototype.padStart() (built-in)',
    'is-even': 'n % 2 === 0 (one-liner)',
    'is-odd': 'n % 2 !== 0 (one-liner)',
    'chalk': 'picocolors (14x smaller, faster)',
    'colors': 'picocolors (colors has had supply chain attacks)',
    'node-fetch': 'native fetch API (built into Node 18+)',
    'cross-fetch': 'native fetch API (built into Node 18+)',
    'isomorphic-fetch': 'native fetch API (built into Node 18+)',
    'whatwg-fetch': 'native fetch API (built into Node 18+)',
    'faker': '@faker-js/faker (faker was hijacked in supply chain attack)',
    'glob': 'fast-glob or fs.glob (built into Node 22+)',
    'rimraf': 'fs.rm with { recursive: true } (built into Node 14+)',
    'mkdirp': 'fs.mkdir with { recursive: true } (built into Node 10+)',
    'ncp': 'fs.cp with { recursive: true } (built into Node 16+)',
    'node-uuid': 'crypto.randomUUID() (node-uuid is unmaintained)',
    'q': 'native Promise (Q is legacy)',
    'async': 'native Promise.all/allSettled/race (async lib is legacy)',
    'superagent': 'native fetch API (built into Node 18+)',
    'path-exists': 'fs.existsSync() or fs.access() (one-liner)',
    'path-is-absolute': 'path.isAbsolute() (built-in)',
    'string-width': 'Intl.Segmenter for grapheme-aware measurement',
    'strip-ansi': 'picocolors includes strip (or regex one-liner)',
};

/**
 * Functional groups — if >1 package from same group is installed,
 * it's likely a duplicate purpose issue from AI drift.
 */
const FUNCTIONAL_GROUPS: { name: string; packages: string[] }[] = [
    { name: 'HTTP clients', packages: ['axios', 'node-fetch', 'got', 'request', 'ky', 'superagent', 'undici'] },
    { name: 'Date/time libraries', packages: ['moment', 'dayjs', 'date-fns', 'luxon', 'fecha', 'chrono-node'] },
    { name: 'Terminal colors', packages: ['chalk', 'kleur', 'ansi-colors', 'picocolors', 'colorette'] },
    { name: 'CLI argument parsers', packages: ['commander', 'yargs', 'meow', 'cac', 'minimist', 'arg'] },
    { name: 'Schema validation', packages: ['zod', 'joi', 'yup', 'ajv', 'superstruct', 'io-ts'] },
    { name: 'Logging libraries', packages: ['winston', 'pino', 'bunyan', 'log4js', 'signale', 'consola'] },
    { name: 'UUID generators', packages: ['uuid', 'nanoid', 'cuid', 'ulid', 'shortid'] },
    { name: 'Markdown parsers', packages: ['marked', 'markdown-it', 'remark', 'showdown', 'remarkable'] },
    { name: 'Testing frameworks', packages: ['jest', 'mocha', 'vitest', 'ava', 'tap', 'jasmine'] },
    { name: 'CSS-in-JS', packages: ['styled-components', 'emotion', '@emotion/react', 'linaria', 'vanilla-extract'] },
    { name: 'State management', packages: ['redux', 'mobx', 'zustand', 'jotai', 'recoil', 'valtio'] },
    { name: 'Environment config', packages: ['dotenv', 'env-var', 'envalid', 'convict'] },
];

export class DependencyGate extends Gate {
    constructor(private config: Config) {
        super('dependency-guardian', 'Dependency Guardian');
    }

    async run(context: GateContext): Promise<Failure[]> {
        const failures: Failure[] = [];
        const depConfig = this.config.gates.dependencies || {};
        const forbidden = depConfig.forbid || [];

        const { cwd } = context;

        // 1. Scan Node.js (package.json) — forbidden + new checks
        const pkgPath = path.join(cwd, 'package.json');
        if (await fs.pathExists(pkgPath)) {
            try {
                const pkg = await fs.readJson(pkgPath);
                const allDeps = {
                    ...(pkg.dependencies || {}),
                    ...(pkg.devDependencies || {}),
                    ...(pkg.peerDependencies || {}),
                };
                const depNames = Object.keys(allDeps);

                // Forbidden deps check
                for (const dep of forbidden) {
                    if (allDeps[dep]) {
                        failures.push(this.createFailure(
                            `The package '${dep}' is forbidden by project standards.`,
                            ['package.json'],
                            `Remove '${dep}' from package.json and use approved alternatives.`,
                            'Forbidden Dependency',
                            undefined,
                            undefined,
                            'medium'
                        ));
                    }
                }

                // NEW: Unused dependency detection
                if (depConfig.detect_unused !== false && depNames.length > 0) {
                    const unusedFailures = await this.detectUnusedDeps(
                        context, pkg, depNames, depConfig.unused_allowlist || []
                    );
                    failures.push(...unusedFailures);
                }

                // NEW: Heavy alternative detection
                if (depConfig.detect_heavy_alternatives !== false) {
                    const heavyFailures = this.detectHeavyAlternatives(depNames);
                    failures.push(...heavyFailures);
                }

                // NEW: Duplicate purpose detection
                if (depConfig.detect_duplicate_purpose !== false) {
                    const dupeFailures = this.detectDuplicatePurpose(depNames);
                    failures.push(...dupeFailures);
                }
            } catch (e) { }
        }

        // 2. Scan Python (requirements.txt, pyproject.toml) — forbidden only
        const reqPath = path.join(cwd, 'requirements.txt');
        if (await fs.pathExists(reqPath)) {
            const content = await fs.readFile(reqPath, 'utf-8');
            for (const dep of forbidden) {
                if (new RegExp(`^${dep}([=<>! ]|$)`, 'm').test(content)) {
                    failures.push(this.createFailure(
                        `The Python package '${dep}' is forbidden.`,
                        ['requirements.txt'],
                        `Remove '${dep}' from requirements.txt.`,
                        'Forbidden Dependency',
                        undefined,
                        undefined,
                        'medium'
                    ));
                }
            }
        }

        const pyprojPath = path.join(cwd, 'pyproject.toml');
        if (await fs.pathExists(pyprojPath)) {
            const content = await fs.readFile(pyprojPath, 'utf-8');
            for (const dep of forbidden) {
                if (new RegExp(`^${dep}\\s*=`, 'm').test(content)) {
                    failures.push(this.createFailure(
                        `The Python package '${dep}' is forbidden in pyproject.toml.`,
                        ['pyproject.toml'],
                        `Remove '${dep}' from pyproject.toml dependencies.`,
                        'Forbidden Dependency',
                        undefined,
                        undefined,
                        'medium'
                    ));
                }
            }
        }

        // 3. Scan Go (go.mod)
        const goModPath = path.join(cwd, 'go.mod');
        if (await fs.pathExists(goModPath)) {
            const content = await fs.readFile(goModPath, 'utf-8');
            for (const dep of forbidden) {
                if (content.includes(dep)) {
                    failures.push(this.createFailure(
                        `The Go module '${dep}' is forbidden.`,
                        ['go.mod'],
                        `Remove '${dep}' from go.mod.`,
                        'Forbidden Dependency',
                        undefined,
                        undefined,
                        'medium'
                    ));
                }
            }
        }

        // 4. Scan Java (pom.xml)
        const pomPath = path.join(cwd, 'pom.xml');
        if (await fs.pathExists(pomPath)) {
            const content = await fs.readFile(pomPath, 'utf-8');
            for (const dep of forbidden) {
                if (content.includes(`<artifactId>${dep}</artifactId>`)) {
                    failures.push(this.createFailure(
                        `The Java artifact '${dep}' is forbidden.`,
                        ['pom.xml'],
                        `Remove '${dep}' from pom.xml.`,
                        'Forbidden Dependency',
                        undefined,
                        undefined,
                        'medium'
                    ));
                }
            }
        }

        return failures;
    }

    // ─── Unused Dependency Detection ─────────────────────────────────

    /**
     * Detect dependencies listed in package.json but never imported.
     * Scans all source files for import/require statements.
     *
     * Allowlist handles side-effect imports like:
     * - @types/* (TypeScript type packages)
     * - polyfills (core-js, regenerator-runtime)
     * - PostCSS/Babel plugins (used in config files, not source)
     */
    private async detectUnusedDeps(
        context: GateContext,
        pkg: any,
        depNames: string[],
        allowlist: string[]
    ): Promise<Failure[]> {
        const failures: Failure[] = [];

        // Check production + dev dependencies. Peer deps and optional deps are valid — skip them.
        const prodDeps = Object.keys(pkg.dependencies || {});
        const devDeps = Object.keys(pkg.devDependencies || {});
        const peerDeps = new Set(Object.keys(pkg.peerDependencies || {}));
        const optionalDeps = new Set(Object.keys(pkg.optionalDependencies || {}));
        const checkDeps = [...prodDeps, ...devDeps].filter(d => !peerDeps.has(d) && !optionalDeps.has(d));

        if (checkDeps.length === 0) return [];

        // Default allowlist patterns for known side-effect packages
        const defaultAllowPatterns = [
            /^@types\//,                    // TypeScript type packages
            /^typescript$/,                 // Used by tsc, not imported
            /^eslint/,                      // Used by config, not imported
            /^prettier$/,                   // Used by config
            /^@eslint/,                     // ESLint config packages
            /^husky$/,                      // Git hooks
            /^lint-staged$/,               // Pre-commit
            /^core-js/,                     // Polyfills
            /^regenerator-runtime$/,        // Babel polyfill
            /^postcss/,                     // PostCSS plugins
            /^autoprefixer$/,              // PostCSS plugin
            /^tailwindcss$/,               // Build tool
            /^@tailwindcss\//,             // Build tool
            /^webpack/,                     // Build tool
            /^vite$/,                       // Build tool
            /^@vitejs\//,                  // Vite plugins
            /^rollup/,                      // Build tool
            /^esbuild$/,                    // Build tool
            /^tsup$/,                       // Build tool
            /^turbo$/,                      // Build tool
            /^nodemon$/,                    // Dev tool
            /^ts-node$/,                    // Dev tool
            /^tsx$/,                        // Dev tool
            /^concurrently$/,              // Dev tool
        ];

        // Combine with user allowlist
        const userPatterns = allowlist.map(p => {
            if (p.endsWith('*')) return new RegExp(`^${p.slice(0, -1)}`);
            return new RegExp(`^${p}$`);
        });
        const allPatterns = [...defaultAllowPatterns, ...userPatterns];

        // Filter deps that need checking
        const depsToCheck = checkDeps.filter(dep =>
            !allPatterns.some(pattern => pattern.test(dep))
        );

        if (depsToCheck.length === 0) return [];

        // Scan source files for import/require patterns
        const sourceFiles = await FileScanner.findFiles({
            cwd: context.cwd,
            patterns: ['**/*.{ts,tsx,js,jsx,mjs,cjs,mts,cts,vue,svelte}'],
            ignore: [...(context.ignore || []), '**/node_modules/**', '**/dist/**'],
        });

        // Read all source files
        const contents = await FileScanner.readFiles(context.cwd, sourceFiles, context.fileCache);

        // Also check config files that might reference deps
        const configFiles = ['vite.config.ts', 'vite.config.js', 'next.config.js', 'next.config.mjs',
            'jest.config.ts', 'jest.config.js', 'vitest.config.ts', 'tsconfig.json',
            'babel.config.js', '.babelrc', 'postcss.config.js', 'tailwind.config.js',
            'webpack.config.js', 'rollup.config.js', 'esbuild.config.js'];

        for (const cf of configFiles) {
            const cfPath = path.join(context.cwd, cf);
            if (await fs.pathExists(cfPath)) {
                try {
                    contents.set(cf, await fs.readFile(cfPath, 'utf-8'));
                } catch { }
            }
        }

        // Build a combined source text for fast searching
        const allSource = Array.from(contents.values()).join('\n');

        for (const dep of depsToCheck) {
            // Check for various import patterns:
            // import ... from 'dep'
            // require('dep')
            // import('dep')
            // Also check for scoped package partial imports: @scope/package/sub
            const depEscaped = dep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const importPattern = new RegExp(
                `(?:from\\s+['"\`]${depEscaped}(?:/[^'"\`]*)?['"\`])|` +
                `(?:require\\s*\\(\\s*['"\`]${depEscaped}(?:/[^'"\`]*)?['"\`]\\s*\\))|` +
                `(?:import\\s*\\(\\s*['"\`]${depEscaped}(?:/[^'"\`]*)?['"\`]\\s*\\))|` +
                `(?:['"\`]${depEscaped}['"\`])`  // Config file references
            );

            if (!importPattern.test(allSource)) {
                const isDevDep = devDeps.includes(dep);
                failures.push(this.createFailure(
                    `${isDevDep ? 'Dev dependency' : 'Dependency'} '${dep}' appears unused — no import/require found in source files.`,
                    ['package.json'],
                    `Remove '${dep}' from package.json if it's truly unused, or add it to unused_allowlist if it's a side-effect import.`,
                    'Unused Dependency',
                    undefined,
                    undefined,
                    'low'
                ));
            }
        }

        if (failures.length > 0) {
            Logger.info(`Dependency Guardian: Found ${failures.length} potentially unused dependencies`);
        }

        return failures;
    }

    // ─── Heavy Alternative Detection ─────────────────────────────────

    /**
     * Detect heavy/bloated packages that have lighter modern alternatives.
     * AI agents tend to reach for the most popular (heaviest) package
     * because that's what they've seen most in training data.
     */
    private detectHeavyAlternatives(depNames: string[]): Failure[] {
        const failures: Failure[] = [];

        for (const dep of depNames) {
            const alternative = HEAVY_ALTERNATIVES[dep];
            if (alternative) {
                failures.push(this.createFailure(
                    `Package '${dep}' has a lighter alternative: ${alternative}.`,
                    ['package.json'],
                    `Consider replacing '${dep}' with ${alternative}. AI agents often default to popular-but-heavy packages.`,
                    'Heavy Dependency',
                    undefined,
                    undefined,
                    'low'
                ));
            }
        }

        return failures;
    }

    // ─── Duplicate Purpose Detection ─────────────────────────────────

    /**
     * Detect when multiple packages serve the same purpose.
     * This is a classic AI drift symptom — different sessions install different
     * packages for the same task (e.g., axios in one PR, got in another).
     */
    private detectDuplicatePurpose(depNames: string[]): Failure[] {
        const failures: Failure[] = [];
        const depSet = new Set(depNames);

        for (const group of FUNCTIONAL_GROUPS) {
            const installed = group.packages.filter(pkg => depSet.has(pkg));
            if (installed.length >= 2) {
                failures.push(this.createFailure(
                    `Multiple ${group.name} installed: ${installed.join(', ')}. Pick one and remove the rest.`,
                    ['package.json'],
                    `Having multiple packages for ${group.name} is a sign of AI drift — different sessions chose different packages. Standardize on one.`,
                    'Duplicate Purpose Dependencies',
                    undefined,
                    undefined,
                    'medium'
                ));
            }
        }

        return failures;
    }
}
