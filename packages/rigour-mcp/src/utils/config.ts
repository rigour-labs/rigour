/**
 * Configuration & Utility Helpers
 *
 * Shared utilities for config loading, memory persistence,
 * Studio event logging, and diff parsing.
 *
 * @since v2.17.0 — extracted from monolithic index.ts
 */
import fs from "fs-extra";
import path from "path";
import yaml from "yaml";
import { randomUUID } from "crypto";
import { ConfigSchema, rigourUserDir } from "@rigour-labs/core";

// ─── Config Loading ───────────────────────────────────────────────
/**
 * The repository's rigour.yml, or Rigour's defaults when it has none. A tool
 * call never writes into the user's repository to create one (run `rigour init`
 * for that), so the first call in a new repository behaves like `rigour review`.
 */
export async function loadConfig(cwd: string) {
    const configPath = path.join(cwd, "rigour.yml");
    if (!(await fs.pathExists(configPath))) {
        noteMissingConfig(cwd);
        return ConfigSchema.parse({});
    }
    const configContent = await fs.readFile(configPath, "utf-8");
    return ConfigSchema.parse(yaml.parse(configContent));
}

const notedMissingConfig = new Set<string>();

function noteMissingConfig(cwd: string): void {
    if (notedMissingConfig.has(cwd)) return;
    notedMissingConfig.add(cwd);
    console.error(`[RIGOUR] No rigour.yml in ${cwd}; using defaults. Run \`npx rigour init\` to configure gates and hooks.`);
}

// ─── Memory Persistence ───────────────────────────────────────────
export interface MemoryStore {
    memories: Record<string, { value: string; timestamp: string }>;
}

/**
 * False when RIGOUR_USER_MEMORY=off. A server kept apart from the user's other work (a private
 * HOME per employer, a sandbox) then never reads or writes ~/.rigour/memory.json, even if it is
 * started with the real home by mistake.
 */
export function userMemoryEnabled(): boolean {
    return process.env.RIGOUR_USER_MEMORY?.trim().toLowerCase() !== 'off';
}

export const USER_MEMORY_OFF = 'User memory is off on this server (RIGOUR_USER_MEMORY=off); use scope "repo".';

/** The repository a call works in: the call's own cwd, else RIGOUR_CWD, else where the server was started. */
export function resolveCwd(args: unknown): string {
    const given = (args as { cwd?: unknown } | undefined)?.cwd;
    return typeof given === 'string' && given ? given : process.env.RIGOUR_CWD || process.cwd();
}

/** Where memories live: `repo` in this checkout's .rigour/, `user` in ~/.rigour/ for every repository. */
export type LocalMemoryScope = 'repo' | 'user';

export async function getMemoryPath(cwd: string, scope: LocalMemoryScope = 'repo'): Promise<string> {
    const rigourDir = scope === 'user' ? rigourUserDir() : path.join(cwd, ".rigour");
    await fs.ensureDir(rigourDir);
    return path.join(rigourDir, "memory.json");
}

export async function loadMemory(cwd: string, scope: LocalMemoryScope = 'repo'): Promise<MemoryStore> {
    if (scope === 'user' && !userMemoryEnabled()) return { memories: {} };
    const memPath = await getMemoryPath(cwd, scope);
    if (await fs.pathExists(memPath)) {
        const content = await fs.readFile(memPath, "utf-8");
        try {
            const parsed = JSON.parse(content);
            if (parsed && typeof parsed === 'object' && parsed.memories && typeof parsed.memories === 'object') {
                return parsed as MemoryStore;
            }
        } catch {
            // fall through to default
        }
    }
    return { memories: {} };
}

export async function saveMemory(cwd: string, store: MemoryStore, scope: LocalMemoryScope = 'repo'): Promise<void> {
    if (scope === 'user' && !userMemoryEnabled()) throw new Error(USER_MEMORY_OFF);
    const memPath = await getMemoryPath(cwd, scope);
    await fs.writeFile(memPath, JSON.stringify(store, null, 2));
}

// ─── MCP Settings ────────────────────────────────────────────────
export interface McpSettings {
    deep_default_mode: 'off' | 'quick' | 'full';
}

const DEFAULT_MCP_SETTINGS: McpSettings = {
    deep_default_mode: 'off',
};

export async function getMcpSettingsPath(cwd: string): Promise<string> {
    const rigourDir = path.join(cwd, ".rigour");
    await fs.ensureDir(rigourDir);
    return path.join(rigourDir, "mcp-settings.json");
}

export async function loadMcpSettings(cwd: string): Promise<McpSettings> {
    const settingsPath = await getMcpSettingsPath(cwd);
    if (!(await fs.pathExists(settingsPath))) {
        return DEFAULT_MCP_SETTINGS;
    }

    try {
        const raw = await fs.readJson(settingsPath);
        const deepMode = raw?.deep_default_mode;
        if (deepMode === 'quick' || deepMode === 'full' || deepMode === 'off') {
            return { deep_default_mode: deepMode };
        }
    } catch {
        // Fall through to defaults.
    }

    return DEFAULT_MCP_SETTINGS;
}

export async function saveMcpSettings(cwd: string, settings: McpSettings): Promise<void> {
    const settingsPath = await getMcpSettingsPath(cwd);
    await fs.writeJson(settingsPath, settings, { spaces: 2 });
}

// ─── Studio Event Logging ─────────────────────────────────────────
export async function logStudioEvent(cwd: string, event: any) {
    try {
        const rigourDir = path.join(cwd, ".rigour");
        await fs.ensureDir(rigourDir);
        const eventsPath = path.join(rigourDir, "events.jsonl");
        const logEntry =
            JSON.stringify({
                id: randomUUID(),
                timestamp: new Date().toISOString(),
                ...event,
            }) + "\n";
        await fs.appendFile(eventsPath, logEntry);
    } catch {
        // Silent fail — Studio logging is non-blocking and zero-telemetry
    }
}
