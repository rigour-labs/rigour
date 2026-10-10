/**
 * What an older Rigour left in this repository that no longer does what it says: an edit hook that checks nothing,
 * and a rigour.yml written before a default changed. `rigour doctor` and `rigour setup` report them; `rigour setup`
 * fixes the ones that only restore what the team had, and leaves a team's possible choice for a person to decide.
 */
import fs from 'fs';
import path from 'path';
import yaml from 'yaml';
import { TEMPLATES } from '@rigour-labs/core';

/** The edit hook older `rigour hooks init` wrote: it passes a variable the agent never sets, so no edit is checked. */
export function isOldEditHook(config: string): boolean {
    return config.includes('TOOL_INPUT_file_path');
}

export interface ConfigMigration {
    id: 'preset-security-block' | 'security-deprecated-default';
    /** What is wrong, in a sentence a person acts on. */
    problem: string;
    /** True when `rigour setup` changes the file; false when only a person can decide. */
    automatic: boolean;
}

/** The presets that block on every security finding (`gates.security.block`), read from the presets themselves. */
function blockingPresets(): Set<string> {
    return new Set(TEMPLATES.filter(t => (t.config.gates as any)?.security?.block === true).map(t => t.name));
}

function readConfig(cwd: string): yaml.Document | undefined {
    const file = path.join(cwd, 'rigour.yml');
    if (!fs.existsSync(file)) return undefined;
    const doc = yaml.parseDocument(fs.readFileSync(file, 'utf8'));
    return doc.errors.length ? undefined : doc;
}

export function configMigrations(cwd: string): ConfigMigration[] {
    const doc = readConfig(cwd);
    if (!doc) return [];
    const found: ConfigMigration[] = [];
    const preset = doc.get('preset');
    if (typeof preset === 'string' && blockingPresets().has(preset) && doc.getIn(['gates', 'security', 'block']) === undefined) {
        found.push({
            id: 'preset-security-block',
            problem: `rigour.yml was made from the ${preset} preset, which blocks on every security finding, but it predates gates.security.block: security findings are shown as notes here, not blocks`,
            automatic: true,
        });
    }
    if (doc.getIn(['gates', 'deprecated_apis', 'block_security_deprecated']) === true) {
        found.push({
            id: 'security-deprecated-default',
            problem: 'rigour.yml sets gates.deprecated_apis.block_security_deprecated: true, which older rigour init wrote for everyone: an API deprecated for security reasons (md5 for a cache key, shell=True with a constant) blocks here. Keep it if your team chose it; otherwise delete the line',
            automatic: false,
        });
    }
    return found;
}

/** Applies the automatic migrations to rigour.yml, keeping its comments and order; returns what it changed. */
export function applyConfigMigrations(cwd: string): string[] {
    const due = configMigrations(cwd).filter(m => m.automatic);
    const doc = due.length ? readConfig(cwd) : undefined;
    if (!doc) return [];
    const done: string[] = [];
    for (const migration of due) {
        if (migration.id === 'preset-security-block') {
            doc.setIn(['gates', 'security', 'block'], true);
            done.push(`rigour.yml: gates.security.block: true, as the ${String(doc.get('preset'))} preset sets it (security findings block again)`);
        }
    }
    fs.writeFileSync(path.join(cwd, 'rigour.yml'), doc.toString());
    return done;
}
