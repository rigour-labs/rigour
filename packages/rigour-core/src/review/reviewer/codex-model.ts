/**
 * The person's own model for a codex judge that runs code. It runs with `--ignore-user-config` (judge-sandbox.ts), so
 * the model, model_provider and [model_providers.*] lines of its home's config.toml, and nothing else (the same lines
 * a backtest's home keeps, judge-isolation.ts), are passed back as `-c` overrides. The provider's key variable is the
 * judge's own login, so it is kept in its environment; the record names the model.
 */
import fs from 'fs';
import path from 'path';
import { modelSettings } from './judge-isolation.js';

export interface CodexModel { overrides: string[]; model?: string; keyVariable?: string }

/** A TOML `key = value` line's value, its trailing comment dropped when it is outside a string. */
function valueOf(raw: string): string {
    const text = raw.trim();
    const quoted = /^("(?:[^"\\]|\\.)*"|'[^']*')/.exec(text);
    return quoted ? quoted[1] : text.replace(/\s+#.*$/, '');
}

const unquote = (value: string) => (/^["']/.test(value) ? value.slice(1, -1) : value);

/** The overrides, the model, and the chosen provider's key variable, from the config.toml in `codexHome`. */
export function codexModel(codexHome: string): CodexModel {
    let text = '';
    try {
        text = modelSettings(fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8'));
    } catch {
        return { overrides: [] };
    }
    const overrides: string[] = [];
    const settings = new Map<string, string>();
    let table = '';
    for (const line of text.split('\n')) {
        const header = /^\s*\[\s*([^\]]+?)\s*\]\s*(#.*)?$/.exec(line)?.[1];
        if (header !== undefined) {
            table = `${header}.`;
            continue;
        }
        const pair = /^\s*([A-Za-z0-9_.-]+|"[^"]+")\s*=\s*(.+)$/.exec(line);
        if (!pair) continue;
        const key = `${table}${pair[1]}`;
        settings.set(key, valueOf(pair[2]));
        overrides.push('-c', `${key}=${valueOf(pair[2])}`);
    }
    const model = settings.get('model');
    const provider = settings.get('model_provider');
    const keyVariable = provider ? settings.get(`model_providers.${unquote(provider)}.env_key`) : undefined;
    return { overrides, ...(model ? { model: unquote(model) } : {}), ...(keyVariable ? { keyVariable: unquote(keyVariable) } : {}) };
}
