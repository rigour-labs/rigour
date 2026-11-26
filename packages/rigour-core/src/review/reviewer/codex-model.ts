/**
 * The person's own model for a codex judge that runs code. It runs with `--ignore-user-config` (judge-sandbox.ts), so
 * from its home's config.toml Rigour passes back, as `-c` overrides, only `model`, `model_provider`, and of the chosen
 * provider's table only `name`, `base_url`, `env_key` and `wire_api`. A provider whose table carries credentials
 * (headers, a bearer token, query parameters) is refused for run_code: Rigour won't put them on a command line, where
 * any process can read them. The provider's key variable is the judge's own login, kept in its environment; the
 * record names the model.
 */
import fs from 'fs';
import path from 'path';
import { modelSettings } from './judge-isolation.js';

export interface CodexModel { overrides: string[]; model?: string; keyVariable?: string; refused?: string }

const PROVIDER_KEYS = new Set(['name', 'base_url', 'env_key', 'wire_api']);
/** What carries a credential in a provider's table, or a way to one. */
const CREDENTIAL_KEY = /header|bearer|token|query_params|secret|password|auth/i;

/** A TOML `key = value` line's value, its trailing comment dropped when it is outside a string. */
function valueOf(raw: string): string {
    const text = raw.trim();
    const quoted = /^("(?:[^"\\]|\\.)*"|'[^']*')/.exec(text);
    return quoted ? quoted[1] : text.replace(/\s+#.*$/, '');
}

const unquote = (value: string) => (/^["']/.test(value) ? value.slice(1, -1) : value);

/** Every `table.key` → value in the model lines of `toml`. */
function settingsOf(toml: string): Map<string, string> {
    const settings = new Map<string, string>();
    let table = '';
    for (const line of modelSettings(toml).split('\n')) {
        const header = /^\s*\[\s*([^\]]+?)\s*\]\s*(#.*)?$/.exec(line)?.[1];
        if (header !== undefined) {
            table = `${header}.`;
            continue;
        }
        const pair = /^\s*([A-Za-z0-9_.-]+|"[^"]+")\s*=\s*(.+)$/.exec(line);
        if (pair) settings.set(`${table}${pair[1]}`, valueOf(pair[2]));
    }
    return settings;
}

/** The overrides, the model, and the chosen provider's key variable, or why run_code is refused, from `codexHome`. */
export function codexModel(codexHome: string): CodexModel {
    let settings: Map<string, string>;
    try {
        settings = settingsOf(fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8'));
    } catch {
        return { overrides: [] };
    }
    const model = settings.get('model');
    const provider = settings.get('model_provider');
    const table = provider ? `model_providers.${unquote(provider)}.` : undefined;
    const ofProvider = [...settings].filter(([key]) => table && key.startsWith(table)).map(([key, value]) => [key.slice(table!.length), value] as const);
    if (ofProvider.some(([key]) => CREDENTIAL_KEY.test(key) && key !== 'env_key')) {
        return { overrides: [], refused: "codex's provider config carries credentials Rigour won't put on a command line" };
    }
    const pass: Array<[string, string]> = [
        ...(model ? [['model', model] as [string, string]] : []),
        ...(provider ? [['model_provider', provider] as [string, string]] : []),
        ...ofProvider.filter(([key]) => PROVIDER_KEYS.has(key)).map(([key, value]) => [`${table}${key}`, value] as [string, string]),
    ];
    const keyVariable = ofProvider.find(([key]) => key === 'env_key')?.[1];
    return {
        overrides: pass.flatMap(([key, value]) => ['-c', `${key}=${value}`]),
        ...(model ? { model: unquote(model) } : {}),
        ...(keyVariable ? { keyVariable: unquote(keyVariable) } : {}),
    };
}
