/**
 * tsconfig `paths`, `baseUrl` and `rootDirs`, resolved the way tsc does.
 *
 * Each option is resolved against the config that declares it, not the one
 * that extends it: SvelteKit's generated `.svelte-kit/tsconfig.json` says
 * `"$lib": ["../src/lib"]`, which means `<repo>/src/lib`, not `<repo>/../src/lib`.
 * A child's `paths` replaces its parent's; later entries of an `extends`
 * array override earlier ones.
 */
import fs from 'fs-extra';
import path from 'path';
import { Logger } from '../../utils/logger.js';

export interface TsPathRule {
    key: string;
    hasWildcard: boolean;
    prefix: string;
    suffix: string;
    targets: string[];
}

export interface TsPathConfig {
    /** Directory `paths` targets are relative to: the effective baseUrl, else the declaring config's folder. */
    baseDir: string;
    rules: TsPathRule[];
    /** Absolute `rootDirs`, each resolved against its declaring config. */
    rootDirs: string[];
}

interface EffectiveOptions {
    baseUrl?: string;
    paths?: { entries: Record<string, unknown>; dir: string };
    rootDirs?: string[];
}

const CONFIG_NAMES = ['tsconfig.json', 'jsconfig.json', 'tsconfig.base.json'];

/** The first config in `searchDir` that defines `paths` or `rootDirs` (directly or inherited). */
export async function loadTsPathConfig(searchDir: string): Promise<TsPathConfig | null> {
    for (const name of CONFIG_NAMES) {
        const configPath = path.join(searchDir, name);
        if (!(await fs.pathExists(configPath))) continue;
        const effective = await readChain(configPath, new Set());
        if (!effective.paths && !effective.rootDirs?.length) continue;
        return {
            baseDir: effective.baseUrl ?? effective.paths?.dir ?? searchDir,
            rules: toRules(effective.paths?.entries ?? {}),
            rootDirs: effective.rootDirs ?? [],
        };
    }
    return null;
}

async function readChain(configPath: string, visited: Set<string>): Promise<EffectiveOptions> {
    const resolved = path.resolve(configPath);
    if (visited.has(resolved)) return {};
    visited.add(resolved);
    const parsed = await readLooseJson(resolved);
    if (!parsed) return {};

    let effective: EffectiveOptions = {};
    for (const extendsPath of extendsList(parsed.extends)) {
        const target = await resolveExtends(resolved, extendsPath);
        if (target) effective = { ...effective, ...await readChain(target, visited) };
        else warnMissingExtends(resolved, extendsPath);
    }

    const dir = path.dirname(resolved);
    const options = parsed.compilerOptions ?? {};
    if (typeof options.baseUrl === 'string') effective.baseUrl = path.resolve(dir, options.baseUrl);
    if (options.paths && typeof options.paths === 'object') effective.paths = { entries: options.paths, dir };
    if (Array.isArray(options.rootDirs)) {
        effective.rootDirs = options.rootDirs.filter((r: unknown): r is string => typeof r === 'string').map((r: string) => path.resolve(dir, r));
    }
    return effective;
}

function extendsList(value: unknown): string[] {
    if (typeof value === 'string') return [value];
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

async function resolveExtends(configPath: string, extendsPath: string): Promise<string | null> {
    const base = extendsPath.startsWith('.') || path.isAbsolute(extendsPath)
        ? path.resolve(path.dirname(configPath), extendsPath)
        : path.resolve(path.dirname(configPath), 'node_modules', extendsPath);
    for (const candidate of [base, `${base}.json`, path.join(base, 'tsconfig.json')]) {
        if (await fs.pathExists(candidate) && (await fs.stat(candidate)).isFile()) return candidate;
    }
    return null;
}

function toRules(entries: Record<string, unknown>): TsPathRule[] {
    const rules: TsPathRule[] = [];
    for (const [key, value] of Object.entries(entries)) {
        if (!Array.isArray(value)) continue;
        const targets = value.filter((v): v is string => typeof v === 'string');
        if (targets.length === 0) continue;
        const [prefix, suffix = ''] = key.split('*');
        rules.push({ key, hasWildcard: key.includes('*'), prefix, suffix, targets });
    }
    // Exact keys first, then the longest wildcard prefix/suffix (tsc's precedence).
    return rules.sort((left, right) => {
        if (left.hasWildcard !== right.hasWildcard) return left.hasWildcard ? 1 : -1;
        return (right.prefix.length + right.suffix.length) - (left.prefix.length + left.suffix.length);
    });
}

const warnedMissingExtends = new Set<string>();

/**
 * A missing `extends` target drops its options. Say so once, instead of
 * reporting every aliased import as missing without a reason.
 */
function warnMissingExtends(configPath: string, extendsPath: string): void {
    const key = `${configPath}\0${extendsPath}`;
    if (warnedMissingExtends.has(key)) return;
    warnedMissingExtends.add(key);
    const hint = extendsPath.includes('.svelte-kit') ? ' Run `svelte-kit sync` first to generate it.' : '';
    Logger.warn(`${path.basename(configPath)} extends '${extendsPath}', which does not exist; its path aliases are ignored.${hint}`);
}

/** JSON with comments and trailing commas, as tsconfig files allow. */
async function readLooseJson(filePath: string): Promise<any | null> {
    try {
        const text = await fs.readFile(filePath, 'utf-8');
        try {
            return JSON.parse(text);
        } catch {
            const noBlockComments = text.replace(/\/\*[\s\S]*?\*\//g, '');
            const noLineComments = noBlockComments.replace(/(^|\s)\/\/.*$/gm, '$1');
            return JSON.parse(noLineComments.replace(/,\s*([}\]])/g, '$1'));
        }
    } catch {
        return null;
    }
}
