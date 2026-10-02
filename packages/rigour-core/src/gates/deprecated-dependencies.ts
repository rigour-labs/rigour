/**
 * Deprecated dependencies: a package.json dependency whose installed version
 * npm marks deprecated.
 *
 * npm deprecates individual versions, so the check asks about the version
 * actually installed (package-lock.json, else node_modules), never the latest;
 * a dependency whose installed version cannot be known says nothing. The
 * finding sits on the dependency's line in package.json, so review reports it
 * when a change adds or moves a dependency onto a deprecated version.
 *
 * Opt-in and advisory: it sends package names and versions to the registry
 * (as `npm install` does). Answers are cached for a day in .rigour/; a slow or
 * unreachable registry means no findings, never a failed check.
 */
import fs from 'fs-extra';
import path from 'path';
import { Gate, type GateContext } from './base.js';
import type { Failure } from '../types/index.js';
import { Logger } from '../utils/logger.js';

export interface DeprecatedDependenciesConfig {
    enabled?: boolean;
    registry?: string;
}

type Fetch = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<any> }>;

const CACHE_FILE = path.join('.rigour', 'deprecated-dependencies.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 3000;
const CONCURRENCY = 8;
const MAX_PACKAGES = 300;

interface CacheEntry { deprecated: string | null; checkedAt: number }

export class DeprecatedDependenciesGate extends Gate {
    constructor(private config: DeprecatedDependenciesConfig = {}, private fetchImpl: Fetch = fetch as unknown as Fetch) {
        super('deprecated-dependencies', 'Deprecated dependency');
    }

    async run(context: GateContext): Promise<Failure[]> {
        if (!this.config.enabled) return [];
        const manifestPath = path.join(context.cwd, 'package.json');
        if (!(await fs.pathExists(manifestPath))) return [];
        const manifestText = await fs.readFile(manifestPath, 'utf8');
        const manifest = JSON.parse(manifestText);
        const names = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).slice(0, MAX_PACKAGES);
        const installed = await installedVersions(context.cwd, names);
        const answers = await this.deprecations(context.cwd, installed);
        return [...answers].flatMap(([name, message]) => [this.createFailure(
            `${name}@${installed.get(name)} is deprecated on npm: ${message}`,
            ['package.json'],
            `Move to the replacement the deprecation names, or a supported version of ${name}.`,
            undefined,
            lineOfDependency(manifestText, name),
            undefined,
            'medium',
        )]);
    }

    /** Deprecation messages for installed versions, from the day's cache and then the registry. */
    private async deprecations(cwd: string, installed: Map<string, string>): Promise<Map<string, string>> {
        const cachePath = path.join(cwd, CACHE_FILE);
        const cache: Record<string, CacheEntry> = await fs.readJson(cachePath).catch(() => ({}));
        const now = Date.now();
        const stale = [...installed].filter(([name, version]) => !(cache[`${name}@${version}`]?.checkedAt > now - CACHE_TTL_MS));
        let unreachable = 0;
        for (let i = 0; i < stale.length; i += CONCURRENCY) {
            await Promise.all(stale.slice(i, i + CONCURRENCY).map(async ([name, version]) => {
                const deprecated = await this.lookup(name, version);
                if (deprecated === undefined) unreachable++;
                else cache[`${name}@${version}`] = { deprecated, checkedAt: now };
            }));
        }
        if (unreachable) Logger.info(`Deprecated dependencies: registry did not answer for ${unreachable} package(s); they are skipped this run.`);
        await fs.outputJson(cachePath, cache, { spaces: 2 }).catch(() => undefined);
        const found = new Map<string, string>();
        for (const [name, version] of installed) {
            const message = cache[`${name}@${version}`]?.deprecated;
            if (message) found.set(name, message);
        }
        return found;
    }

    /** The version's deprecation message, null when it is not deprecated, undefined when the registry did not answer. */
    private async lookup(name: string, version: string): Promise<string | null | undefined> {
        const registry = (this.config.registry ?? 'https://registry.npmjs.org').replace(/\/+$/, '');
        try {
            const response = await this.fetchImpl(`${registry}/${name.replace('/', '%2F')}/${encodeURIComponent(version)}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
            if (!response.ok) return undefined;
            const body = await response.json();
            return typeof body?.deprecated === 'string' && body.deprecated.trim() ? body.deprecated.trim() : null;
        } catch {
            return undefined;
        }
    }
}

/** Installed versions from package-lock.json, else node_modules; names with neither are left out. */
export async function installedVersions(cwd: string, names: string[]): Promise<Map<string, string>> {
    const lock = await fs.readJson(path.join(cwd, 'package-lock.json')).catch(() => null);
    const versions = new Map<string, string>();
    for (const name of names) {
        const fromLock = lock?.packages?.[`node_modules/${name}`]?.version ?? lock?.dependencies?.[name]?.version;
        const fromModules = fromLock ? undefined : (await fs.readJson(path.join(cwd, 'node_modules', name, 'package.json')).catch(() => null))?.version;
        const version = fromLock ?? fromModules;
        if (typeof version === 'string' && /^\d+\.\d+\.\d+/.test(version)) versions.set(name, version);
    }
    return versions;
}

/** The package.json line declaring a dependency, so review can tell whether the change touched it. */
export function lineOfDependency(manifestText: string, name: string): number | undefined {
    const at = manifestText.split('\n').findIndex(line => line.trimStart().startsWith(`${JSON.stringify(name)}:`));
    return at >= 0 ? at + 1 : undefined;
}
