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

/** Why an allowed setting is still left out: it would expand a variable (`${VAR}`; bun's `$VAR`). */
const EXPANDS = ' (expands a variable)';

/**
 * The allowed part of a copied settings file, by its name; undefined for a file that is not settings. A kept setting
 * whose value expands a variable is left out too, unless `expand` (`--deps-env`): the variables the install inherits
 * (a proxy's) can carry credentials, and a registry the commit names would be sent them.
 */
export function allowedSettings(rel: string, text: string, expand = false): Allowed | undefined {
    const name = path.posix.basename(rel);
    const plain = (value: string, bun = false) => expand || !(bun ? /\$/ : /\$\{/).test(value);
    if (name === '.npmrc') return byLine(text, line => /^\s*([^=\s][^=]*?)\s*=/.exec(line)?.[1], key => NPMRC_KEYS.test(key), plain);
    if (name === '.yarnrc') return byLine(text, line => /^\s*("[^"]+"|[^\s#]+)/.exec(line)?.[1], key => YARN1_KEYS.test(key), plain);
    if (name === '.yarnrc.yml') return yamlKeys(text, YARN_TOP, (key, value, dropped) => (key === 'npmScopes' ? scopes(value, dropped, plain) : value), plain);
    if (name === 'pnpm-workspace.yaml') return yamlKeys(text, PNPM_WORKSPACE, (_key, value) => value, plain);
    if (name === 'bunfig.toml') return bunfig(text, value => plain(value, true));
    return undefined;
}

/** Line-based settings (ini-like): a line whose key is allowed is kept; blank lines and comments go too. */
function byLine(text: string, keyOf: (line: string) => string | undefined, allowed: (key: string) => boolean, plain: (value: string) => boolean): Allowed {
    const kept: string[] = [];
    const dropped: string[] = [];
    for (const line of text.split(/\r?\n/)) {
        if (!line.trim() || /^\s*[#;]/.test(line)) continue;
        const key = keyOf(line)?.trim();
        if (!key || !allowed(key)) dropped.push(key ?? 'an unreadable line');
        else if (!plain(line.slice(line.indexOf(key) + key.length))) dropped.push(key + EXPANDS);
        else kept.push(line);
    }
    return { text: kept.length ? `${kept.join('\n')}\n` : '', dropped };
}

/** A YAML settings file's allowed top-level keys, each passed through `keep`. */
function yamlKeys(text: string, allowed: Set<string>, keep: (key: string, value: unknown, dropped: string[]) => unknown, plain: (value: string) => boolean): Allowed {
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
        if (!allowed.has(key)) dropped.push(key);
        else if (key !== 'npmScopes' && !plain(JSON.stringify(value) ?? '')) dropped.push(key + EXPANDS);
        else kept[key] = keep(key, value, dropped);
    }
    return { text: Object.keys(kept).length ? yaml.stringify(kept) : '', dropped };
}

/** Each scope's registry and sign-in, nothing else. */
function scopes(value: unknown, dropped: string[], plain: (value: string) => boolean): Record<string, Record<string, unknown>> {
    const out: Record<string, Record<string, unknown>> = {};
    if (!value || typeof value !== 'object') return out;
    for (const [scope, settings] of Object.entries(value)) {
        out[scope] = {};
        for (const [key, v] of Object.entries(settings && typeof settings === 'object' ? settings : {})) {
            if (!YARN_SCOPE.has(key)) dropped.push(`npmScopes.${scope}.${key}`);
            else if (!plain(JSON.stringify(v) ?? '')) dropped.push(`npmScopes.${scope}.${key}${EXPANDS}`);
            else out[scope][key] = v;
        }
    }
    return out;
}

/** bunfig.toml: only `[install]`'s registry and the `[install.scopes]` table. */
function bunfig(text: string, plain: (value: string) => boolean): Allowed {
    const kept: string[] = [];
    const dropped: string[] = [];
    let table = '';
    for (const line of text.split(/\r?\n/)) {
        if (!line.trim() || /^\s*#/.test(line)) continue;
        const header = /^\s*\[+\s*([^\]]+?)\s*\]+\s*(#.*)?$/.exec(line)?.[1];
        if (header !== undefined) table = header;
        const why = header !== undefined ? bunTable(header) : bunSetting(table, line, plain);
        if (why === undefined) kept.push(line);
        else if (why) dropped.push(why);
    }
    return { text: kept.length ? `${kept.join('\n')}\n` : '', dropped };
}

/** A table header: kept for the tables whose settings may be (undefined), else dropped silently (''). */
function bunTable(table: string): string | undefined {
    return table === 'install' || table === 'install.scopes' ? undefined : '';
}

/** One setting: undefined when kept, else the name it is left out under. */
function bunSetting(table: string, line: string, plain: (value: string) => boolean): string | undefined {
    const key = /^\s*([^=\s]+)\s*=/.exec(line)?.[1] ?? 'an unreadable line';
    const named = table ? `${table}.${key}` : key;
    if (!((table === 'install' && key === 'registry') || table === 'install.scopes')) return named;
    return plain(line.slice(line.indexOf('=') + 1)) ? undefined : named + EXPANDS;
}
