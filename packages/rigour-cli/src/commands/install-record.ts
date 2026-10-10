/**
 * What Rigour writes into a repository, so it can take exactly that back out (`rigour uninstall`).
 *
 * Two kinds of writes. A file Rigour creates (CLAUDE.md when there was none, a Cline hook script,
 * `.mcp.json`) is recorded with the hash of what was written, in `.rigour/installed.json`: it is
 * removed later only if nobody has edited it since. A config the person already had (their
 * `.claude/settings.json` with its own permissions and hooks) is never replaced: Rigour's entries
 * are merged in, and taken out again by recognising them, so everything else in the file survives
 * both ways.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const RECORD = path.join('.rigour', 'installed.json');

interface InstallRecord { created: Record<string, string> }

const sha = (content: string) => crypto.createHash('sha256').update(content).digest('hex');

export function readInstallRecord(cwd: string): InstallRecord {
    try {
        const parsed = JSON.parse(fs.readFileSync(path.join(cwd, RECORD), 'utf8'));
        return { created: parsed && typeof parsed.created === 'object' ? parsed.created : {} };
    } catch {
        return { created: {} };
    }
}

/** Notes a file Rigour created, with the hash of what it wrote. */
export function recordCreated(cwd: string, relPath: string, content: string): void {
    const record = readInstallRecord(cwd);
    record.created[relPath.split(path.sep).join('/')] = sha(content);
    fs.mkdirSync(path.join(cwd, '.rigour'), { recursive: true });
    fs.writeFileSync(path.join(cwd, RECORD), JSON.stringify(record, null, 2) + '\n');
}

/** Whether a recorded file still holds exactly what Rigour wrote (nobody edited it). */
export function unchangedSinceInstall(record: InstallRecord, relPath: string, content: string): boolean {
    return record.created[relPath] === sha(content);
}

/** A server entry Rigour wrote (npx of its MCP package), which setup may re-pin; one the person changed is theirs. */
export function isRigourMcpEntry(entry: unknown): boolean {
    const e = entry as { command?: unknown; args?: unknown } | undefined;
    return e?.command === 'npx' && Array.isArray(e.args) && e.args.some(a => typeof a === 'string' && a.startsWith('@rigour-labs/mcp'));
}

/** A hook script Rigour wrote (the Cline hooks): it names Rigour in its header or runs the Rigour CLI. */
export function isRigourScript(text: string): boolean {
    return /hook for Rigour|@rigour-labs\/cli/.test(text) || isRigourCommand(text);
}

/** A hook command Rigour installed: it names Rigour and one of its hook subcommands. */
function isRigourCommand(command: string): boolean {
    return /rigour/i.test(command) && /\bhooks\s+(check|stop|push|review-background)\b/.test(command);
}

/**
 * The config with every Rigour entry taken out: hook entries whose command is Rigour's (and an
 * event list or matcher group left empty by that), and the `rigour` MCP server. Anything else,
 * the person's own hooks included, is kept as it was.
 */
export function withoutRigour(value: unknown): unknown {
    if (Array.isArray(value)) {
        const kept: unknown[] = [];
        for (const item of value) {
            if (isRigourEntry(item)) continue;
            const stripped = withoutRigour(item);
            // A matcher group whose only hooks were Rigour's goes with them (its emptied `hooks` list is already gone).
            if (isObject(item) && Array.isArray(item.hooks) && item.hooks.length > 0 && isObject(stripped) && !(Array.isArray(stripped.hooks) && stripped.hooks.length > 0)) continue;
            kept.push(stripped);
        }
        return kept;
    }
    if (!isObject(value)) return value;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
        if (key === 'mcpServers' && isObject(child)) {
            const servers = Object.fromEntries(Object.entries(child).filter(([name]) => name !== 'rigour'));
            if (Object.keys(servers).length) out[key] = servers;
            continue;
        }
        const stripped = withoutRigour(child);
        // An event list emptied by removing Rigour's entries goes too; one that was already empty stays.
        if (Array.isArray(child) && child.length > 0 && Array.isArray(stripped) && stripped.length === 0) continue;
        if (key === 'hooks' && isObject(child) && Object.keys(child).length > 0 && isObject(stripped) && Object.keys(stripped).length === 0) continue;
        out[key] = stripped;
    }
    return out;
}

/**
 * Rigour's hook entries merged into an existing config: earlier Rigour entries are replaced, the
 * person's own entries and every other setting are kept. `generated` is the config Rigour would
 * write on its own (`{ hooks: { Event: [...] } }`, plus e.g. Cursor's `version`).
 */
export function mergeHooksInto(existing: unknown, generated: Record<string, unknown>): Record<string, unknown> {
    const base = isObject(existing) ? withoutRigour(existing) as Record<string, unknown> : {};
    const merged: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(generated)) {
        if (key !== 'hooks') {
            if (!(key in merged)) merged[key] = value;
            continue;
        }
        const hooks = isObject(merged.hooks) ? { ...merged.hooks } : {};
        for (const [event, entries] of Object.entries(value as Record<string, unknown[]>)) {
            hooks[event] = [...(Array.isArray(hooks[event]) ? hooks[event] as unknown[] : []), ...entries];
        }
        merged.hooks = hooks;
    }
    return merged;
}

/** Nothing left but structure Rigour itself would have added (`{}`, `{ hooks: {} }`, Cursor's `{ version: 1 }`). */
export function isEmptyConfig(value: unknown): boolean {
    if (!isObject(value)) return false;
    return Object.entries(value).every(([key, child]) => (key === 'version' && typeof child === 'number') || (isObject(child) && Object.keys(child).length === 0));
}

function isRigourEntry(item: unknown): boolean {
    return isObject(item) && typeof item.command === 'string' && isRigourCommand(item.command);
}

function isObject(value: unknown): value is Record<string, any> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
