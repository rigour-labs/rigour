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
import { ConfigSchema } from "@rigour-labs/core";

// ─── Config Loading ───────────────────────────────────────────────
export async function loadConfig(cwd: string) {
    const configPath = path.join(cwd, "rigour.yml");
    if (!(await fs.pathExists(configPath))) {
        console.error(`[RIGOUR] rigour.yml not found in ${cwd}, auto-initializing...`);
        const { execa } = await import("execa");
        try {
            await execa("npx", ["rigour", "init"], { cwd, shell: true });
            console.error(`[RIGOUR] Auto-initialization complete.`);
        } catch (initError: any) {
            throw new Error(
                `Rigour auto-initialization failed: ${initError.message}. Please run 'npx rigour init' manually.`
            );
        }
    }
    const configContent = await fs.readFile(configPath, "utf-8");
    return ConfigSchema.parse(yaml.parse(configContent));
}

// ─── Memory Persistence ───────────────────────────────────────────
export interface MemoryStore {
    memories: Record<string, { value: string; timestamp: string }>;
}

export async function getMemoryPath(cwd: string): Promise<string> {
    const rigourDir = path.join(cwd, ".rigour");
    await fs.ensureDir(rigourDir);
    return path.join(rigourDir, "memory.json");
}

export async function loadMemory(cwd: string): Promise<MemoryStore> {
    const memPath = await getMemoryPath(cwd);
    if (await fs.pathExists(memPath)) {
        const content = await fs.readFile(memPath, "utf-8");
        return JSON.parse(content);
    }
    return { memories: {} };
}

export async function saveMemory(cwd: string, store: MemoryStore): Promise<void> {
    const memPath = await getMemoryPath(cwd);
    await fs.writeFile(memPath, JSON.stringify(store, null, 2));
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

// ─── Diff Parsing ─────────────────────────────────────────────────
export function parseDiff(diff: string): Record<string, Set<number>> {
    const lines = diff.split("\n");
    const mapping: Record<string, Set<number>> = {};
    let currentFile = "";
    let currentLine = 0;

    for (const line of lines) {
        if (line.startsWith("+++ b/")) {
            currentFile = line.slice(6);
            mapping[currentFile] = new Set();
        } else if (line.startsWith("@@")) {
            const match = line.match(/\+(\d+)/);
            if (match) {
                currentLine = parseInt(match[1], 10);
            }
        } else if (line.startsWith("+") && !line.startsWith("+++")) {
            if (currentFile) {
                mapping[currentFile].add(currentLine);
            }
            currentLine++;
        } else if (!line.startsWith("-")) {
            currentLine++;
        }
    }
    return mapping;
}
