/**
 * Observed context savings: tokens an agent did not read because Rigour scoped its context.
 *
 * The estimate in context telemetry assumes the agent would otherwise read every
 * scoped file whole, and does not read them afterwards anyway. Neither is
 * measured. Here both sides are observed:
 *
 *   .rigour/context-scopes.jsonl   files rigour_context_scope summarised, with their tokens
 *   .rigour/agent-activity.jsonl   every tool call the agent's hook saw (and the file it read)
 *
 * A scope is tracked when the hook recorded any agent activity after it, so
 * "the agent read nothing" is told apart from "no hook is installed". For a
 * tracked scope, the saving is the tokens of scoped files the agent did not
 * read within the window, less the summary it read instead.
 */
import fs from 'fs';
import path from 'path';

const SCOPES = 'context-scopes.jsonl';
const ACTIVITY = 'agent-activity.jsonl';
const MAX_LOG_BYTES = 2 * 1024 * 1024;
export const OBSERVATION_WINDOW_MS = 30 * 60 * 1000;
const READ_TOOLS = /^(?:read|read_file|readfile|view|open_file|cat)$/i;

export interface ScopeOffer {
    ts: number;
    files: Array<{ path: string; tokens: number }>;
    summaryTokens: number;
}

export interface AgentActivity {
    ts: number;
    tool: string;
    path?: string;
}

export interface ObservedSavings {
    scopes: number;
    /** Scopes followed by agent activity the hook saw: the only ones measured. */
    trackedScopes: number;
    offeredTokens: number;
    /** Tokens of scoped files the agent read anyway. */
    readBackTokens: number;
    /** Tokens of scoped files never read, less the summaries, over tracked scopes. */
    avoidedTokens: number;
}

export function recordScopeOffer(cwd: string, files: Array<{ path: string; tokens: number }>, summaryTokens: number, ts = Date.now()): void {
    append(cwd, SCOPES, { ts, files: files.map(f => ({ path: normalize(cwd, f.path), tokens: f.tokens })), summaryTokens });
}

/** One tool call an agent hook saw. Read-like tools carry the file they read. */
export function recordAgentActivity(cwd: string, tool: string, filePath?: string, ts = Date.now()): void {
    const entry: AgentActivity = { ts, tool };
    if (filePath && READ_TOOLS.test(tool)) entry.path = normalize(cwd, filePath);
    append(cwd, ACTIVITY, entry);
}

/**
 * A hook payload for one agent tool call (Claude Code PreToolUse sends tool_name,
 * tool_input and cwd); anything else is ignored.
 */
export function recordHookPayload(payload: unknown, fallbackCwd: string, ts = Date.now()): void {
    const event = payload as { tool_name?: unknown; tool_input?: Record<string, unknown>; cwd?: unknown } | null;
    if (!event || typeof event.tool_name !== 'string') return;
    const input = event.tool_input ?? {};
    const file = [input.file_path, input.path, input.target_file].find((v): v is string => typeof v === 'string');
    recordAgentActivity(typeof event.cwd === 'string' ? event.cwd : fallbackCwd, event.tool_name, file, ts);
}

export function observedSavings(cwd: string, windowMs = OBSERVATION_WINDOW_MS): ObservedSavings {
    const scopes = readLog<ScopeOffer>(cwd, SCOPES);
    const activity = readLog<AgentActivity>(cwd, ACTIVITY).sort((a, b) => a.ts - b.ts);
    const result: ObservedSavings = { scopes: scopes.length, trackedScopes: 0, offeredTokens: 0, readBackTokens: 0, avoidedTokens: 0 };
    for (const scope of scopes) {
        const after = activity.filter(a => a.ts >= scope.ts && a.ts <= scope.ts + windowMs);
        if (after.length === 0) continue;
        result.trackedScopes++;
        const read = new Set(after.filter(a => a.path).map(a => a.path));
        const offered = scope.files.reduce((sum, f) => sum + f.tokens, 0);
        const readBack = scope.files.filter(f => read.has(f.path)).reduce((sum, f) => sum + f.tokens, 0);
        result.offeredTokens += offered;
        result.readBackTokens += readBack;
        result.avoidedTokens += Math.max(0, offered - readBack - scope.summaryTokens);
    }
    return result;
}

function normalize(cwd: string, file: string): string {
    return path.relative(cwd, path.resolve(cwd, file)).split(path.sep).join('/');
}

function append(cwd: string, name: string, entry: object): void {
    try {
        const dir = path.join(cwd, '.rigour');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, name);
        fs.appendFileSync(file, JSON.stringify(entry) + '\n');
        if (fs.statSync(file).size > MAX_LOG_BYTES) {
            const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
            fs.writeFileSync(file, lines.slice(Math.floor(lines.length / 2)).join('\n') + '\n');
        }
    } catch {
        // Measurement must never break the agent's tool call.
    }
}

function readLog<T>(cwd: string, name: string): T[] {
    try {
        return fs.readFileSync(path.join(cwd, '.rigour', name), 'utf8').split('\n').filter(Boolean)
            .flatMap(line => { try { return [JSON.parse(line) as T]; } catch { return []; } });
    } catch {
        return [];
    }
}
