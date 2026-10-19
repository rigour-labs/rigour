/**
 * A commit's package-manager settings, cut to an allowlist before a backtest installs with them: where the registries
 * are, how to trust them, and how to sign in to them (which carries nothing without `--deps-env`, the environment being
 * minimal). Every other setting can name a program or code to run (npm's node-options, git, script-shell; yarn's
 * yarnPath and plugins; pnpm's nodeOptions; bun's preload), so it is left out, and the round says which keys were (never their values).
 */
import path from 'path';
import yaml from 'yaml';

/** A settings file as installed, and the keys left out of it. */
export interface Allowed { text: string; dropped: string[] }

const NPMRC_KEYS = /^(registry|@[^:\s]+:registry|ca|ca\[\]|cafile|strict-ssl|\/\/[^\s]+:(_authToken|_auth|username|_password|always-auth))$/;
const YARN1_KEYS = /^("?)(registry|@[^:\s"]+:registry)\1$/;
/** yarn 2+: registries, trust and sign-in, and nodeLinker (a layout name, never a path: without it yarn writes no node_modules). */
const YARN_TOP = new Set(['npmRegistryServer', 'npmScopes', 'npmAuthToken', 'npmAuthIdent', 'npmAlwaysAuth', 'httpsCaFilePath', 'caFilePath', 'enableStrictSsl', 'nodeLinker']);
const YARN_SCOPE = new Set(['npmRegistryServer', 'npmAuthToken', 'npmAuthIdent', 'npmAlwaysAuth']);
/** pnpm-workspace.yaml: the workspace and what the frozen lockfile is checked against, never a setting that runs something. */
const PNPM_WORKSPACE = new Set(['packages', 'catalog', 'catalogs', 'overrides', 'patchedDependencies', 'packageExtensions']);

/** The allowed part of a copied settings file, by its name; undefined for a file that is not settings. */
export function allowedSettings(rel: string, text: string): Allowed | undefined {
    const name = path.posix.basename(rel);
    if (name === '.npmrc') return byLine(text, line => /^\s*([^=\s][^=]*?)\s*=/.exec(line)?.[1], key => NPMRC_KEYS.test(key));
    if (name === '.yarnrc') return byLine(text, line => /^\s*("[^"]+"|[^\s#]+)/.exec(line)?.[1], key => YARN1_KEYS.test(key));
    if (name === '.yarnrc.yml') return yamlKeys(text, YARN_TOP, (key, value, dropped) => (key === 'npmScopes' ? scopes(value, dropped) : value));
    if (name === 'pnpm-workspace.yaml') return yamlKeys(text, PNPM_WORKSPACE, (_key, value) => value);
    if (name === 'bunfig.toml') return bunfig(text);
    return undefined;
}

/** Line-based settings (ini-like): a line whose key is allowed is kept; blank lines and comments go too. */
function byLine(text: string, keyOf: (line: string) => string | undefined, allowed: (key: string) => boolean): Allowed {
    const kept: string[] = [];
    const dropped: string[] = [];
    for (const line of text.split(/\r?\n/)) {
        if (!line.trim() || /^\s*[#;]/.test(line)) continue;
        const key = keyOf(line)?.trim();
        if (key && allowed(key)) kept.push(line);
        else dropped.push(key ?? 'an unreadable line');
    }
    return { text: kept.length ? `${kept.join('\n')}\n` : '', dropped };
}

/** A YAML settings file's allowed top-level keys, each passed through `keep`. */
function yamlKeys(text: string, allowed: Set<string>, keep: (key: string, value: unknown, dropped: string[]) => unknown): Allowed {
    let parsed: unknown;
    try {
        parsed = yaml.parse(text) ?? {};
    } catch {
        return { text: '', dropped: ['the whole file (it does not parse)'] };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { text: '', dropped: ['the whole file (not settings)'] };
    const kept: Record<string, unknown> = {};
    const dropped: string[] = [];
    for (const [key, value] of Object.entries(parsed)) {
        if (allowed.has(key)) kept[key] = keep(key, value, dropped);
        else dropped.push(key);
    }
    return { text: Object.keys(kept).length ? yaml.stringify(kept) : '', dropped };
}

/** Each scope's registry and sign-in, nothing else. */
function scopes(value: unknown, dropped: string[]): Record<string, Record<string, unknown>> {
    const out: Record<string, Record<string, unknown>> = {};
    if (!value || typeof value !== 'object') return out;
    for (const [scope, settings] of Object.entries(value)) {
        out[scope] = {};
        for (const [key, v] of Object.entries(settings && typeof settings === 'object' ? settings : {})) {
            if (YARN_SCOPE.has(key)) out[scope][key] = v;
            else dropped.push(`npmScopes.${scope}.${key}`);
        }
    }
    return out;
}

/** bunfig.toml: only `[install]`'s registry and the `[install.scopes]` table. */
function bunfig(text: string): Allowed {
    const kept: string[] = [];
    const dropped: string[] = [];
    let table = '';
    for (const line of text.split(/\r?\n/)) {
        if (!line.trim() || /^\s*#/.test(line)) continue;
        const header = /^\s*\[+\s*([^\]]+?)\s*\]+\s*(#.*)?$/.exec(line)?.[1];
        if (header !== undefined) {
            table = header;
            if (table === 'install' || table === 'install.scopes') kept.push(line);
            continue;
        }
        const key = /^\s*([^=\s]+)\s*=/.exec(line)?.[1] ?? 'an unreadable line';
        if ((table === 'install' && key === 'registry') || table === 'install.scopes') kept.push(line);
        else dropped.push(table ? `${table}.${key}` : key);
    }
    return { text: kept.length ? `${kept.join('\n')}\n` : '', dropped };
}
