/**
 * Staleness Detector
 * 
 * Detects when AI is suggesting deprecated or outdated patterns.
 * Uses package.json analysis and a deprecation database.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import semver from 'semver';
import type {
    StalenessResult,
    StalenessIssue,
    DeprecationEntry
} from './types.js';

/**
 * Built-in deprecation database.
 * This is bundled with Rigour and updated with releases.
 */
import { BUILT_IN_DEPRECATIONS } from './staleness-data.js';


/**
 * Project context extracted from package.json and other config files.
 */
interface ProjectContext {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
    nodeVersion?: string;
    typescriptVersion?: string;
}

/**
 * Staleness Detector class.
 */
export class StalenessDetector {
    private deprecations: DeprecationEntry[];
    private projectContext: ProjectContext | null = null;
    private rootDir: string;

    constructor(rootDir: string, customDeprecations: DeprecationEntry[] = []) {
        this.rootDir = rootDir;
        this.deprecations = [...BUILT_IN_DEPRECATIONS, ...customDeprecations];
    }

    /**
     * Load project context from package.json.
     */
    async loadProjectContext(): Promise<ProjectContext> {
        if (this.projectContext) {
            return this.projectContext;
        }

        const pkgPath = path.join(this.rootDir, 'package.json');

        try {
            const content = await fs.readFile(pkgPath, 'utf-8');
            const pkg = JSON.parse(content);

            this.projectContext = {
                dependencies: pkg.dependencies || {},
                devDependencies: pkg.devDependencies || {},
                nodeVersion: pkg.engines?.node,
                typescriptVersion: (pkg.devDependencies?.typescript || pkg.dependencies?.typescript)
            };

            return this.projectContext;
        } catch {
            this.projectContext = {
                dependencies: {},
                devDependencies: {}
            };
            return this.projectContext;
        }
    }

    /**
     * Check code for staleness issues.
     */
    async checkStaleness(code: string, filePath?: string): Promise<StalenessResult> {
        const context = await this.loadProjectContext();
        const issues: StalenessIssue[] = [];

        // 1. Check built-in/remote rules
        const lines = code.split('\n');
        for (const deprecation of this.deprecations) {
            // Check if this deprecation applies to the project
            if (deprecation.library && !this.hasLibrary(deprecation.library, context)) {
                continue;
            }

            // Check version constraints
            if (deprecation.library && deprecation.deprecatedIn !== 'ecosystem' &&
                deprecation.deprecatedIn !== 'best-practice' &&
                deprecation.deprecatedIn !== 'es6') {

                const installed = this.getInstalledVersion(deprecation.library, context);
                if (installed && !semver.gte(
                    semver.coerce(installed) || '0.0.0',
                    semver.coerce(deprecation.deprecatedIn) || '0.0.0'
                )) {
                    // Project is on older version where this isn't deprecated yet
                    continue;
                }
            }

            // Check for pattern match
            const regex = new RegExp(deprecation.pattern, 'g');
            for (let i = 0; i < lines.length; i++) {
                if (regex.test(lines[i])) {
                    issues.push({
                        line: i + 1,
                        pattern: deprecation.pattern,
                        severity: deprecation.severity,
                        reason: deprecation.reason || `Deprecated in ${deprecation.deprecatedIn}`,
                        replacement: deprecation.replacement,
                        docs: deprecation.docs
                    });
                }
                regex.lastIndex = 0;
            }
        }

        // Determine overall status
        let status: StalenessResult['status'] = 'FRESH';
        if (issues.some(i => i.severity === 'error')) {
            status = 'DEPRECATED';
        } else if (issues.some(i => i.severity === 'warning')) {
            status = 'STALE';
        }

        // Build project context for response
        const projectContextOutput: Record<string, string> = {};
        for (const [name, version] of Object.entries(context.dependencies)) {
            if (['react', 'react-dom', 'next', 'typescript', 'redux', 'express'].includes(name)) {
                projectContextOutput[name] = version;
            }
        }
        for (const [name, version] of Object.entries(context.devDependencies)) {
            if (['typescript'].includes(name)) {
                projectContextOutput[name] = version;
            }
        }

        return {
            status,
            issues,
            projectContext: projectContextOutput
        };
    }

    /**
     * Check if project has a library.
     */
    private hasLibrary(library: string, context: ProjectContext): boolean {
        return library in context.dependencies || library in context.devDependencies;
    }

    /**
     * Get installed version of a library.
     */
    private getInstalledVersion(library: string, context: ProjectContext): string | null {
        const version = context.dependencies[library] || context.devDependencies[library];
        if (!version) return null;

        // Remove version prefix (^, ~, >=, etc.)
        return version.replace(/^[\^~>=<]+/, '');
    }

    /**
     * Add custom deprecation rules.
     */
    addDeprecation(entry: DeprecationEntry): void {
        this.deprecations.push(entry);
    }

    /**
     * Load deprecations from a YAML file.
     */
    async loadDeprecationsFromFile(filePath: string): Promise<void> {
        try {
            const content = await fs.readFile(filePath, 'utf-8');
            const { parse } = await import('yaml');
            const data = parse(content);

            if (data.deprecations && Array.isArray(data.deprecations)) {
                this.deprecations.push(...data.deprecations);
            }
        } catch (error) {
            console.error(`Failed to load deprecations from ${filePath}:`, error);
        }
    }

    /**
     * Get all deprecations for display.
     */
    getAllDeprecations(): DeprecationEntry[] {
        return [...this.deprecations];
    }
}

/**
 * Quick helper to check code for staleness.
 */
export async function checkCodeStaleness(
    rootDir: string,
    code: string
): Promise<StalenessResult> {
    const detector = new StalenessDetector(rootDir);
    return detector.checkStaleness(code);
}
