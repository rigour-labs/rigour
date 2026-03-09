/**
 * Manifest discovery and workspace package detection for hallucinated-imports gate.
 *
 * Handles:
 * - Discovery of workspace packages from pnpm-workspace.yaml, package.json, lerna.json
 * - Glob pattern matching for workspace packages
 * - Dynamic scanning of project manifests for all supported languages
 */

import fs from 'fs-extra';
import path from 'path';

export interface LoadPackageJsonResult {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    workspaces?: string[] | { packages?: string[] };
    exports?: Record<string, any>;
    name?: string;
}

/**
 * Load package.json from the project root.
 */
export async function loadPackageJson(cwd: string): Promise<LoadPackageJsonResult> {
    try {
        const packageJsonPath = path.join(cwd, 'package.json');
        if (await fs.pathExists(packageJsonPath)) {
            return await fs.readJson(packageJsonPath);
        }
    } catch { /* skip */ }
    return {};
}

/**
 * Discover workspace packages from pnpm-workspace.yaml, package.json workspaces, lerna.json.
 * Returns a set of package names that are valid imports.
 */
export async function discoverWorkspacePackages(cwd: string, allProjectFiles: Set<string>): Promise<Set<string>> {
    const packages = new Set<string>();

    // 1. Check pnpm-workspace.yaml
    const pnpmWorkspacePath = path.join(cwd, 'pnpm-workspace.yaml');
    if (await fs.pathExists(pnpmWorkspacePath)) {
        try {
            const content = await fs.readFile(pnpmWorkspacePath, 'utf-8');
            const packagesMatch = content.match(/packages:\s*\n((?:\s+-\s+['"]?[^\n]+\n?)*)/);
            if (packagesMatch) {
                const globs = packagesMatch[1].match(/-\s+['"]?([^'"\n]+)/g);
                if (globs) {
                    for (const g of globs) {
                        const pattern = g.replace(/-\s+['"]?/, '').replace(/['"]?\s*$/, '').trim();
                        await addWorkspacePackagesFromGlob(cwd, pattern, allProjectFiles, packages);
                    }
                }
            }
        } catch { /* skip */ }
    }

    // 2. Check root package.json workspaces field
    try {
        const rootPkg = await loadPackageJson(cwd);
        const workspaces = rootPkg?.workspaces;
        if (workspaces) {
            const patterns = Array.isArray(workspaces) ? workspaces : workspaces.packages || [];
            for (const pattern of patterns) {
                await addWorkspacePackagesFromGlob(cwd, pattern, allProjectFiles, packages);
            }
        }
    } catch { /* skip */ }

    // 3. Check lerna.json
    const lernaPath = path.join(cwd, 'lerna.json');
    if (await fs.pathExists(lernaPath)) {
        try {
            const lerna = await fs.readJson(lernaPath);
            const patterns = lerna.packages || ['packages/*'];
            for (const pattern of patterns) {
                await addWorkspacePackagesFromGlob(cwd, pattern, allProjectFiles, packages);
            }
        } catch { /* skip */ }
    }

    return packages;
}

/**
 * Find package.json files matching a workspace glob pattern
 * and add their names to the packages set.
 */
async function addWorkspacePackagesFromGlob(
    cwd: string,
    pattern: string,
    allProjectFiles: Set<string>,
    packages: Set<string>
): Promise<void> {
    const normalizedPattern = pattern.replace(/\*\*?$/, '').replace(/\/$/, '');
    for (const file of allProjectFiles) {
        if (!file.endsWith('package.json')) continue;
        const dir = path.dirname(file);
        if (dir.startsWith(normalizedPattern) || matchGlobPrefix(dir, pattern)) {
            try {
                const pkg = await fs.readJson(path.join(cwd, file));
                if (pkg.name) {
                    packages.add(pkg.name);
                    if (pkg.exports) {
                        packages.add(pkg.name);
                    }
                }
            } catch { /* skip */ }
        }
    }
}

/**
 * Simple glob matching for workspace patterns.
 * Handles "packages/*" and similar patterns.
 */
function matchGlobPrefix(dirPath: string, pattern: string): boolean {
    const parts = pattern.split('/');
    const dirParts = dirPath.split('/');
    for (let i = 0; i < parts.length; i++) {
        if (parts[i] === '*' || parts[i] === '**') return true;
        if (i >= dirParts.length) return false;
        if (parts[i] !== dirParts[i]) return false;
    }
    return true;
}
