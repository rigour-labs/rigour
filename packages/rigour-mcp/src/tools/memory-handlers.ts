/**
 * Memory Persistence Tool Handlers
 *
 * Handlers for: rigour_remember, rigour_recall, rigour_forget
 *
 * @since v2.17.0 — extracted from monolithic index.ts
 */
import { loadMemory, saveMemory } from '../utils/config.js';

type ToolResult = { content: { type: string; text: string }[] };

export async function handleRemember(cwd: string, key: string, value: string): Promise<ToolResult> {
    const store = await loadMemory(cwd);
    store.memories[key] = { value, timestamp: new Date().toISOString() };
    await saveMemory(cwd, store);
    return {
        content: [{
            type: "text",
            text: `MEMORY STORED: "${key}" has been saved. This instruction will persist across sessions.\n\nStored value: ${value}`,
        }],
    };
}

export async function handleRecall(cwd: string, key?: string): Promise<ToolResult> {
    const store = await loadMemory(cwd);

    if (key) {
        const memory = store.memories[key];
        if (!memory) {
            return { content: [{ type: "text", text: `NO MEMORY FOUND for key "${key}". Use rigour_remember to store instructions.` }] };
        }
        return { content: [{ type: "text", text: `RECALLED MEMORY [${key}]:\n${memory.value}\n\n(Stored: ${memory.timestamp})` }] };
    }

    const keys = Object.keys(store.memories);
    if (keys.length === 0) {
        return { content: [{ type: "text", text: "NO MEMORIES STORED. Use rigour_remember to persist important instructions." }] };
    }

    const allMemories = keys.map(k => {
        const mem = store.memories[k];
        return `## ${k}\n${mem.value}\n(Stored: ${mem.timestamp})`;
    }).join("\n\n---\n\n");

    return {
        content: [{
            type: "text",
            text: `RECALLED ALL MEMORIES (${keys.length} items):\n\n${allMemories}\n\n---\nIMPORTANT: Follow these stored instructions throughout this session.`,
        }],
    };
}

export async function handleForget(cwd: string, key: string): Promise<ToolResult> {
    const store = await loadMemory(cwd);
    if (!store.memories[key]) {
        return { content: [{ type: "text", text: `NO MEMORY FOUND for key "${key}". Nothing to forget.` }] };
    }
    delete store.memories[key];
    await saveMemory(cwd, store);
    return { content: [{ type: "text", text: `MEMORY DELETED: "${key}" has been removed.` }] };
}
