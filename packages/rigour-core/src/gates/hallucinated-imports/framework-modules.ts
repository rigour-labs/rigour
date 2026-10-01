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

const NUXT_PACKAGE = 'nuxt';
/** Nuxt's aliases (`~`/`@` = srcDir, `~~`/`@@` = rootDir) and virtual `#imports`, `#app`, `#build`, …. */
const NUXT_ALIAS = /^(?:~~?|@@?)(?:\/|$)|^#/;
/** Nuxt's generated build directory, imported relatively. */
const NUXT_GENERATED = /(?:^|\/)\.nuxt(?:\/|$)/;
/** Packages Nuxt and Nitro supply to every app, imported without being declared. */
const NUXT_SUPPLIED = new Set([
    'h3', 'ofetch', 'ufo', 'defu', 'destr', 'ohash', 'pathe', 'scule', 'consola', 'hookable', 'unstorage', 'unctx',
    'cookie-es', 'radix3', 'knitwork', 'nitropack', 'vue', 'vue-router', 'unhead', '@unhead/vue', '@nuxt/schema', '@nuxt/kit',
]);

/** A framework's project root for a file (nearest package.json depending on it), cached per directory. */
export class FrameworkRoots {
    private cache = new Map<string, string | null>();

    constructor(private readonly cwd: string, private readonly frameworkPackage: string) { }

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
            if (await declares(path.join(dir, 'package.json'), this.frameworkPackage)) {
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

export class SvelteKitRoots extends FrameworkRoots {
    constructor(cwd: string) {
        super(cwd, SVELTEKIT_PACKAGE);
    }
}

export class NuxtRoots extends FrameworkRoots {
    constructor(cwd: string) {
        super(cwd, NUXT_PACKAGE);
    }
}

/** In a Nuxt app: an alias, a virtual `#` module, the generated `.nuxt/`, or a package Nuxt supplies. */
export function isNuxtProvided(importPath: string, packageName: string): boolean {
    return NUXT_ALIAS.test(importPath) || NUXT_GENERATED.test(importPath) || NUXT_SUPPLIED.has(packageName) || packageName.startsWith('@vue/');
}

async function declares(packageJsonPath: string, frameworkPackage: string): Promise<boolean> {
    if (!(await fs.pathExists(packageJsonPath))) return false;
    try {
        const pkg = await fs.readJson(packageJsonPath);
        return [pkg?.dependencies, pkg?.devDependencies, pkg?.peerDependencies]
            .some(deps => !!deps && Object.prototype.hasOwnProperty.call(deps, frameworkPackage));
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
