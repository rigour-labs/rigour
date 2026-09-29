/**
 * Framework-provided modules that no package.json or tsconfig declares.
 *
 * SvelteKit supplies `$app/*`, `$env/*` and `$service-worker` as virtual
 * modules and generates each route's `./$types`. Its `$lib` alias lives in
 * `.svelte-kit/tsconfig.json`, which `svelte-kit sync` generates and git
 * ignores, so on a fresh clone or in CI the tsconfig mapping is missing and
 * `$lib/...` would be read as an uninstalled package.
 */
import fs from 'fs-extra';
import path from 'path';
import { resolveTsPathTarget } from './ts-path-target.js';

const SVELTEKIT_PACKAGE = '@sveltejs/kit';
const SVELTEKIT_VIRTUAL = /^(?:\$app|\$env)\/|^\$service-worker$/;
const GENERATED_TYPES = /^\.{1,2}\/(?:.*\/)?\$types(?:\.d\.ts|\.js)?$/;
const LIB_ALIAS = /^\$lib(?:\/(.*))?$/;

/** SvelteKit project root for a file (nearest package.json depending on the kit), cached per directory. */
export class SvelteKitRoots {
    private cache = new Map<string, string | null>();

    constructor(private readonly cwd: string) { }

    async rootFor(file: string): Promise<string | null> {
        const top = path.resolve(this.cwd);
        const visited: string[] = [];
        let dir = path.dirname(path.resolve(this.cwd, file));
        let found: string | null = null;
        while (dir.startsWith(top)) {
            if (this.cache.has(dir)) {
                found = this.cache.get(dir) ?? null;
                break;
            }
            visited.push(dir);
            if (await declaresKit(path.join(dir, 'package.json'))) {
                found = dir;
                break;
            }
            const parent = path.dirname(dir);
            if (parent === dir) break;
            dir = parent;
        }
        for (const d of visited) this.cache.set(d, found);
        return found;
    }
}

async function declaresKit(packageJsonPath: string): Promise<boolean> {
    if (!(await fs.pathExists(packageJsonPath))) return false;
    try {
        const pkg = await fs.readJson(packageJsonPath);
        return [pkg?.dependencies, pkg?.devDependencies, pkg?.peerDependencies]
            .some(deps => !!deps && Object.prototype.hasOwnProperty.call(deps, SVELTEKIT_PACKAGE));
    } catch {
        return false;
    }
}

/** `$app/*`, `$env/*`, `$service-worker`, or a route's generated `./$types`. */
export function isSvelteKitProvided(importPath: string): boolean {
    return SVELTEKIT_VIRTUAL.test(importPath) || GENERATED_TYPES.test(importPath);
}

/**
 * Resolve `$lib` / `$lib/...` to the kit's default `src/lib` folder.
 * Returns null when the import is not a `$lib` import.
 */
export async function resolveSvelteKitLib(
    importPath: string,
    kitRoot: string,
    cwd: string,
    projectFiles: Set<string>,
): Promise<boolean | null> {
    const match = importPath.match(LIB_ALIAS);
    if (!match) return null;
    const target = match[1] ? path.join('src/lib', match[1]) : 'src/lib';
    return resolveTsPathTarget(kitRoot, target, cwd, projectFiles);
}
