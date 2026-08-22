import { Command } from 'commander';
import path from 'path';
import os from 'os';
import chalk from 'chalk';
import { execa } from 'execa';
import fs from 'fs-extra';
import http from 'http';
import type { IncomingMessage, ServerResponse } from 'http';
import { randomUUID } from 'crypto';

type StudioContext = {
    cwd: string;
    eventsPath: string;
    allowedOrigins: Set<string>;
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
}

async function readJsonIfExists(filePath: string): Promise<any | null> {
    if (!(await fs.pathExists(filePath))) return null;
    try {
        return await fs.readJson(filePath);
    } catch {
        return null;
    }
}

async function mergeMemoryStores(cwd: string): Promise<{ memories: Record<string, any>; sources: string[] }> {
    const sources: string[] = [];
    const memories: Record<string, any> = {};

    const projectPath = path.join(cwd, '.rigour/memory.json');
    const globalPath = path.join(os.homedir(), '.rigour/memory.json');

    for (const [label, filePath] of [
        ['project', projectPath],
        ['global', globalPath],
    ] as const) {
        const data = await readJsonIfExists(filePath);
        if (!data) continue;
        sources.push(label);
        const entries = data.memories && typeof data.memories === 'object' ? data.memories : data;
        for (const [key, value] of Object.entries(entries || {})) {
            const namespaced = memories[key] ? `${label}:${key}` : key;
            memories[namespaced] = {
                ...(typeof value === 'object' && value !== null ? value : { value }),
                source: label,
            };
        }
    }

    return { memories, sources };
}

function mapCheckpointMetrics(metrics: Array<{
    checkpointId: string;
    taskId: string;
    agentId: string;
    rawStateTokens?: number;
    checkpointTokens?: number;
    replayTokensAvoided?: number;
    createdAt?: number;
}>) {
    return metrics.map((m) => {
        const raw = m.rawStateTokens || 0;
        const packed = m.checkpointTokens || 0;
        const avoided = m.replayTokensAvoided || Math.max(0, raw - packed);
        const compression = packed > 0 ? Math.round(raw / packed) : 0;
        const qualityScore = Math.max(40, Math.min(100, 60 + Math.min(40, compression)));
        const createdAt = m.createdAt ?? Date.now();
        return {
            checkpointId: m.checkpointId,
            agentId: m.agentId,
            taskId: m.taskId,
            timestamp: new Date(createdAt).toISOString(),
            progressPct: Math.min(100, Math.round((avoided / Math.max(raw, 1)) * 100)),
            filesChanged: [] as string[],
            summary: `Compressed ${raw.toLocaleString()} → ${packed.toLocaleString()} tokens; avoided ${avoided.toLocaleString()} replay tokens${compression ? ` (${compression}×)` : ''}.`,
            qualityScore,
            warnings: [] as string[],
            rawStateTokens: raw,
            checkpointTokens: packed,
            replayTokensAvoided: avoided,
        };
    });
}

async function synthesizeAgents(cwd: string, checkpoints: Array<{ agentId: string; taskId?: string; timestamp: string }>) {
    const sessionPath = path.join(cwd, '.rigour/agent-session.json');
    const session = await readJsonIfExists(sessionPath);
    if (session?.agents?.length) {
        return session;
    }

    const byAgent = new Map<string, { agentId: string; taskScope: string[]; registeredAt: string; lastCheckpoint?: string; status: 'active' | 'idle' | 'completed' }>();
    for (const cp of checkpoints) {
        const existing = byAgent.get(cp.agentId);
        if (!existing) {
            byAgent.set(cp.agentId, {
                agentId: cp.agentId,
                taskScope: cp.taskId ? [`task:${cp.taskId}`] : [],
                registeredAt: cp.timestamp,
                lastCheckpoint: cp.timestamp,
                status: 'completed',
            });
        } else {
            existing.lastCheckpoint = cp.timestamp;
            if (cp.taskId && !existing.taskScope.includes(`task:${cp.taskId}`)) {
                existing.taskScope.push(`task:${cp.taskId}`);
            }
        }
    }

    const agents = [...byAgent.values()];
    return {
        sessionId: agents.length ? 'derived-from-checkpoints' : 'inactive',
        agents,
        status: agents.length ? 'completed' : 'inactive',
        createdAt: agents[0]?.registeredAt || new Date().toISOString(),
        derived: true,
    };
}

async function handleApiRequest(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    ctx: StudioContext,
): Promise<boolean> {
    if (!url.pathname.startsWith('/api')) return false;

    const requestOrigin = req.headers.origin;
    if (typeof requestOrigin === 'string' && ctx.allowedOrigins.has(requestOrigin)) {
        res.setHeader('Access-Control-Allow-Origin', requestOrigin);
        res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS, POST, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return true;
    }

    const { cwd, eventsPath } = ctx;

    if (url.pathname === '/api/events') {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
        });

        if (await fs.pathExists(eventsPath)) {
            const content = await fs.readFile(eventsPath, 'utf8');
            const lines = content.split('\n').filter((l) => l.trim());
            // Send recent history only — full 77MB dumps freeze the UI
            for (const line of lines.slice(-200)) {
                res.write(`data: ${line}\n\n`);
            }
        }

        await fs.ensureDir(path.dirname(eventsPath));
        const watcher = fs.watch(path.dirname(eventsPath), async (_eventType, filename) => {
            if (filename === 'events.jsonl') {
                try {
                    const content = await fs.readFile(eventsPath, 'utf8');
                    const lines = content.split('\n').filter((l) => l.trim());
                    const lastLine = lines[lines.length - 1];
                    if (lastLine) res.write(`data: ${lastLine}\n\n`);
                } catch {
                    // ignore transient reads
                }
            }
        });
        req.on('close', () => watcher.close());
        return true;
    }

    if (url.pathname === '/api/file') {
        const filePath = url.searchParams.get('path');
        if (!filePath) {
            res.writeHead(400);
            res.end('Missing path');
            return true;
        }
        const absolutePath = path.resolve(cwd, filePath);
        if (!absolutePath.startsWith(cwd)) {
            res.writeHead(403);
            res.end('Forbidden');
            return true;
        }
        try {
            const content = await fs.readFile(absolutePath, 'utf8');
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end(content);
        } catch {
            res.writeHead(404);
            res.end('Not found');
        }
        return true;
    }

    if (url.pathname === '/api/info') {
        try {
            const pkgPath = path.join(cwd, 'package.json');
            const pkg = (await fs.pathExists(pkgPath)) ? await fs.readJson(pkgPath) : {};
            const __dirname = path.dirname(new URL(import.meta.url).pathname);
            const cliPkgPath = path.join(__dirname, '../../package.json');
            const mcpPkgCandidates = [
                path.join(__dirname, '../../../rigour-mcp/package.json'),
                path.join(__dirname, '../../../../packages/rigour-mcp/package.json'),
            ];
            const cliPkg = (await fs.pathExists(cliPkgPath)) ? await fs.readJson(cliPkgPath) : {};
            let mcpVersion = '5.5.0';
            for (const candidate of mcpPkgCandidates) {
                if (await fs.pathExists(candidate)) {
                    const mcpPkg = await fs.readJson(candidate);
                    mcpVersion = mcpPkg.version || mcpVersion;
                    break;
                }
            }
            // Product version is the MCP/governance release; CLI package may differ.
            const studioVersion = mcpVersion || cliPkg.version || '0.0.0';
            sendJson(res, 200, {
                name: pkg.name || path.basename(cwd),
                projectName: pkg.name || path.basename(cwd),
                path: cwd,
                projectPath: cwd,
                version: pkg.version || '0.0.0',
                projectVersion: pkg.version || '0.0.0',
                studioVersion,
                mcpVersion,
                brainDb: path.join(os.homedir(), '.rigour/rigour.db'),
            });
        } catch (e: any) {
            res.writeHead(500);
            res.end(e.message);
        }
        return true;
    }

    if (url.pathname === '/api/tree') {
        try {
            const getTree = async (dir: string): Promise<string[]> => {
                const entries = await fs.readdir(dir, { withFileTypes: true });
                let files: string[] = [];
                const exclude = ['node_modules', '.git', '.rigour', '.venv', 'dist', 'build'];
                for (const entry of entries) {
                    if (exclude.includes(entry.name) || entry.name.startsWith('.')) continue;
                    const fullPath = path.join(dir, entry.name);
                    if (entry.isDirectory()) {
                        files = [...files, ...(await getTree(fullPath))];
                    } else {
                        files.push(path.relative(cwd, fullPath));
                    }
                }
                return files;
            };
            sendJson(res, 200, await getTree(cwd));
        } catch (e: any) {
            res.writeHead(500);
            res.end(e.message);
        }
        return true;
    }

    if (url.pathname === '/api/config') {
        try {
            const configPath = path.join(cwd, 'rigour.yml');
            if (await fs.pathExists(configPath)) {
                res.writeHead(200, { 'Content-Type': 'text/yaml' });
                res.end(await fs.readFile(configPath, 'utf8'));
            } else {
                res.writeHead(404);
                res.end('Not found');
            }
        } catch (e: any) {
            res.writeHead(500);
            res.end(e.message);
        }
        return true;
    }

    if (url.pathname === '/api/memory') {
        try {
            sendJson(res, 200, await mergeMemoryStores(cwd));
        } catch (e: any) {
            sendJson(res, 500, { error: e.message });
        }
        return true;
    }

    if (url.pathname === '/api/index-stats') {
        try {
            const indexPath = path.join(cwd, '.rigour/patterns.json');
            if (await fs.pathExists(indexPath)) {
                sendJson(res, 200, await fs.readJson(indexPath));
            } else {
                sendJson(res, 200, { patterns: [], stats: { totalPatterns: 0, totalFiles: 0, byType: {} } });
            }
        } catch (e: any) {
            sendJson(res, 500, { error: e.message });
        }
        return true;
    }

    if (url.pathname === '/api/index-search') {
        const query = url.searchParams.get('q');
        if (!query) {
            res.writeHead(400);
            res.end('Missing query');
            return true;
        }
        try {
            const { generateEmbedding, semanticSearch } = await import('@rigour-labs/core/pattern-index');
            const indexPath = path.join(cwd, '.rigour/patterns.json');
            const indexData = await fs.readJson(indexPath);
            const queryVector = await generateEmbedding(query);
            const similarities = semanticSearch(queryVector, indexData.patterns);
            const results = indexData.patterns
                .map((p: any, i: number) => ({ ...p, similarity: similarities[i] }))
                .filter((p: any) => p.similarity > 0.3)
                .sort((a: any, b: any) => b.similarity - a.similarity)
                .slice(0, 20);
            sendJson(res, 200, results);
        } catch (e: any) {
            sendJson(res, 500, { error: e.message });
        }
        return true;
    }

    if (url.pathname === '/api/checkpoints' || url.pathname === '/api/agents') {
        try {
            const {
                getCheckpointMetrics,
            } = await import('@rigour-labs/core');
            const metrics = await getCheckpointMetrics(undefined, cwd);
            const mapped = mapCheckpointMetrics(metrics);
            const sessionFile = await readJsonIfExists(path.join(cwd, '.rigour/checkpoint-session.json'));
            const sessionCheckpoints = Array.isArray(sessionFile?.checkpoints) ? sessionFile.checkpoints : [];
            const checkpoints = sessionCheckpoints.length > 0 ? sessionCheckpoints : mapped;

            if (url.pathname === '/api/checkpoints') {
                sendJson(res, 200, {
                    checkpoints,
                    status: checkpoints.length ? 'active' : 'inactive',
                    source: sessionCheckpoints.length ? 'session' : 'brain-metrics',
                    metricsCount: metrics.length,
                });
            } else {
                sendJson(res, 200, await synthesizeAgents(cwd, checkpoints));
            }
        } catch (e: any) {
            sendJson(res, 500, { error: e.message });
        }
        return true;
    }

    if (url.pathname === '/api/overview') {
        try {
            const {
                getTaskContextStats,
                getTaskCostStats,
                getCacheStats,
                getCheckpointSummary,
                getCheckpointMetrics,
            } = await import('@rigour-labs/core');
            const [context, cost, cache, checkpointSummary, metrics, memory, indexStats] = await Promise.all([
                getTaskContextStats(undefined, cwd),
                getTaskCostStats(undefined, cwd),
                getCacheStats(cwd),
                getCheckpointSummary(undefined, cwd),
                getCheckpointMetrics(undefined, cwd),
                mergeMemoryStores(cwd),
                readJsonIfExists(path.join(cwd, '.rigour/patterns.json')),
            ]);
            let recentEvents = 0;
            if (await fs.pathExists(eventsPath)) {
                const content = await fs.readFile(eventsPath, 'utf8');
                recentEvents = content.split('\n').filter((l) => l.trim()).length;
            }
            sendJson(res, 200, {
                context,
                cost,
                cache,
                checkpointSummary,
                checkpointCount: metrics.length,
                memoryCount: Object.keys(memory.memories).length,
                memorySources: memory.sources,
                patternCount: indexStats?.stats?.totalPatterns ?? indexStats?.patterns?.length ?? 0,
                patternFiles: indexStats?.stats?.totalFiles ?? 0,
                eventCount: recentEvents,
                projectPath: cwd,
                brainDb: path.join(os.homedir(), '.rigour/rigour.db'),
            });
        } catch (e: any) {
            sendJson(res, 500, { error: e.message });
        }
        return true;
    }

    if (url.pathname === '/api/report-stats') {
        try {
            const reportPath = path.join(cwd, 'rigour-report.json');
            if (await fs.pathExists(reportPath)) {
                const report = await fs.readJson(reportPath);
                sendJson(res, 200, report.stats || {});
            } else {
                sendJson(res, 200, {});
            }
        } catch (e: any) {
            sendJson(res, 500, { error: e.message });
        }
        return true;
    }

    if (url.pathname === '/api/deep-findings') {
        try {
            const reportPath = path.join(cwd, 'rigour-report.json');
            if (await fs.pathExists(reportPath)) {
                const report = await fs.readJson(reportPath);
                const findings = (report.failures || []).filter(
                    (f: any) => f.provenance === 'deep-analysis' || f.source === 'llm' || f.source === 'hybrid',
                );
                sendJson(res, 200, findings);
            } else {
                sendJson(res, 200, []);
            }
        } catch (e: any) {
            sendJson(res, 500, { error: e.message });
        }
        return true;
    }

    if (url.pathname === '/api/drift') {
        try {
            const { generateTemporalDriftReport } = await import('@rigour-labs/core');
            const report = generateTemporalDriftReport(cwd);
            sendJson(res, 200, report || { totalScans: 0 });
        } catch {
            sendJson(res, 200, { totalScans: 0 });
        }
        return true;
    }

    if (url.pathname === '/api/context-stats') {
        try {
            const { getTaskContextStats } = await import('@rigour-labs/core');
            const taskId = url.searchParams.get('taskId') || undefined;
            sendJson(res, 200, await getTaskContextStats(taskId, cwd));
        } catch (e: any) {
            sendJson(res, 500, { error: e.message });
        }
        return true;
    }

    if (url.pathname === '/api/task-cost') {
        try {
            const { getTaskCostStats } = await import('@rigour-labs/core');
            const taskId = url.searchParams.get('taskId') || undefined;
            sendJson(res, 200, await getTaskCostStats(taskId, cwd));
        } catch (e: any) {
            sendJson(res, 500, { error: e.message });
        }
        return true;
    }

    if (url.pathname === '/api/cache-stats') {
        try {
            const { getCacheStats } = await import('@rigour-labs/core');
            sendJson(res, 200, await getCacheStats(cwd));
        } catch (e: any) {
            sendJson(res, 500, { error: e.message });
        }
        return true;
    }

    if (url.pathname === '/api/context-explain') {
        try {
            const { explainContext } = await import('@rigour-labs/core');
            const target = url.searchParams.get('target') || 'all';
            const taskId = url.searchParams.get('taskId') || undefined;
            sendJson(res, 200, await explainContext(target, taskId, cwd));
        } catch (e: any) {
            sendJson(res, 500, { error: e.message });
        }
        return true;
    }

    if (url.pathname === '/api/context-scope') {
        try {
            const { getContextScopeSummary } = await import('@rigour-labs/core');
            sendJson(res, 200, await getContextScopeSummary(cwd));
        } catch (e: any) {
            sendJson(res, 500, { error: e.message });
        }
        return true;
    }

    if (url.pathname === '/api/checkpoint-metrics') {
        try {
            const { getCheckpointSummary } = await import('@rigour-labs/core');
            const taskId = url.searchParams.get('taskId') || undefined;
            sendJson(res, 200, await getCheckpointSummary(taskId, cwd));
        } catch (e: any) {
            sendJson(res, 500, { error: e.message });
        }
        return true;
    }

    if (url.pathname === '/api/cursor-api-key/status') {
        try {
            const {
                getCursorApiKey,
                getCursorApiKeyHint,
                countCursorAdminImportedEvents,
            } = await import('@rigour-labs/core');
            const key = getCursorApiKey();
            const fromEnv = Boolean(
                process.env.RIGOUR_CURSOR_API_KEY?.trim() || process.env.CURSOR_ADMIN_API_KEY?.trim(),
            );
            sendJson(res, 200, {
                configured: Boolean(key),
                hint: getCursorApiKeyHint(),
                source: key ? (fromEnv ? 'env' : 'file') : 'none',
                importedCount: await countCursorAdminImportedEvents(cwd),
            });
        } catch (e: any) {
            sendJson(res, 500, { error: e.message });
        }
        return true;
    }

    if (url.pathname === '/api/cursor-sync' && req.method === 'POST') {
        try {
            const { syncCursorUsageFromAdminApi } = await import('@rigour-labs/core');
            const result = await syncCursorUsageFromAdminApi(cwd);
            sendJson(res, 200, { success: true, ...result });
        } catch (e: any) {
            sendJson(res, 502, { success: false, error: e.message || 'Cursor usage sync failed' });
        }
        return true;
    }

    if (url.pathname === '/api/cursor-api-key' && req.method === 'DELETE') {
        try {
            const {
                removeCursorApiKey,
                getCursorApiKey,
                getCursorApiKeyHint,
            } = await import('@rigour-labs/core');
            removeCursorApiKey();
            const key = getCursorApiKey();
            const fromEnv = Boolean(
                process.env.RIGOUR_CURSOR_API_KEY?.trim() || process.env.CURSOR_ADMIN_API_KEY?.trim(),
            );
            sendJson(res, 200, {
                success: true,
                configured: Boolean(key),
                hint: getCursorApiKeyHint(),
                source: key ? (fromEnv ? 'env' : 'file') : 'none',
            });
        } catch (e: any) {
            sendJson(res, 500, { error: e.message });
        }
        return true;
    }

    if (url.pathname === '/api/cursor-api-key' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', async () => {
            try {
                const parsed = JSON.parse(body || '{}');
                const apiKey = typeof parsed.apiKey === 'string' ? parsed.apiKey.trim() : '';
                if (!apiKey || apiKey.length > 512) {
                    sendJson(res, 400, { error: 'Missing or invalid apiKey' });
                    return;
                }
                const {
                    updateCursorApiKey,
                    syncCursorUsageFromAdminApi,
                    getCursorApiKeyHint,
                } = await import('@rigour-labs/core');
                updateCursorApiKey(apiKey);
                let syncResult = { importedCount: 0, totalEvents: 0 };
                let syncError: string | undefined;
                try {
                    syncResult = await syncCursorUsageFromAdminApi(cwd);
                } catch (syncErr: any) {
                    syncError = syncErr?.message || 'Initial Cursor sync failed';
                }
                sendJson(res, 200, {
                    success: true,
                    configured: true,
                    hint: getCursorApiKeyHint(),
                    source: 'file',
                    importedCount: syncResult.importedCount,
                    totalEvents: syncResult.totalEvents,
                    syncError,
                });
            } catch (e: any) {
                sendJson(res, 500, { error: e.message });
            }
        });
        return true;
    }

    if (url.pathname === '/api/handoffs') {
        try {
            const handoffPath = path.join(cwd, '.rigour/handoffs.jsonl');
            const handoffs: any[] = [];
            if (await fs.pathExists(handoffPath)) {
                const content = await fs.readFile(handoffPath, 'utf8');
                for (const line of content.split('\n').filter((l) => l.trim())) {
                    try {
                        handoffs.push(JSON.parse(line));
                    } catch {
                        // skip bad lines
                    }
                }
            }
            if (await fs.pathExists(eventsPath)) {
                const content = await fs.readFile(eventsPath, 'utf8');
                for (const line of content.split('\n').filter((l) => l.trim()).slice(-500)) {
                    try {
                        const ev = JSON.parse(line);
                        if (ev.type === 'handoff_accepted' && ev.handoffId) {
                            const target = handoffs.find((h) => h.handoffId === ev.handoffId);
                            if (target) {
                                target.status = 'accepted';
                                target.acceptedAt = ev.timestamp || ev.ts;
                            }
                        }
                    } catch {
                        // skip
                    }
                }
            }
            sendJson(res, 200, {
                handoffs: handoffs.slice(-100).reverse(),
                count: handoffs.length,
            });
        } catch (e: any) {
            sendJson(res, 500, { error: e.message });
        }
        return true;
    }

    if (url.pathname === '/api/enforcement') {
        try {
            const {
                getCheckpointMetrics,
            } = await import('@rigour-labs/core');
            const metrics = await getCheckpointMetrics(undefined, cwd);
            const mapped = mapCheckpointMetrics(metrics);
            const agentsSession = await synthesizeAgents(cwd, mapped);
            const memory = await mergeMemoryStores(cwd);

            let events: any[] = [];
            if (await fs.pathExists(eventsPath)) {
                const content = await fs.readFile(eventsPath, 'utf8');
                events = content
                    .split('\n')
                    .filter((l) => l.trim())
                    .slice(-400)
                    .map((l) => {
                        try {
                            return JSON.parse(l);
                        } catch {
                            return null;
                        }
                    })
                    .filter(Boolean);
            }

            const handoffPath = path.join(cwd, '.rigour/handoffs.jsonl');
            let handoffCount = 0;
            let acceptedHandoffs = 0;
            if (await fs.pathExists(handoffPath)) {
                const content = await fs.readFile(handoffPath, 'utf8');
                const lines = content.split('\n').filter((l) => l.trim());
                handoffCount = lines.length;
                acceptedHandoffs = events.filter((e) => e.type === 'handoff_accepted').length;
            }

            const typeCount = (types: string[]) =>
                events.filter((e) => types.includes(e.type) || types.includes(e.tool)).length;

            const registerCount = Math.max(
                agentsSession.agents?.length || 0,
                typeCount(['agent_registered', 'rigour_agent_register']),
            );
            const scopeCount = typeCount(['context_scoped', 'rigour_context_scope', 'scope_resolved']);
            const gateCount = typeCount([
                'gate_failed',
                'gate_passed',
                'hook_blocked',
                'interception_requested',
                'rigour_check',
            ]);
            const gateBlocked = typeCount(['gate_failed', 'hook_blocked', 'interception_requested']);
            const checkpointCount = Math.max(
                mapped.length,
                typeCount(['checkpoint_recorded', 'rigour_checkpoint']),
            );
            const memoryCount = Object.keys(memory.memories || {}).length;

            const stage = (
                id: string,
                label: string,
                count: number,
                status: 'idle' | 'pass' | 'warn' | 'block',
                detail: string,
            ) => ({ id, label, count, status, detail });

            const stages = [
                stage(
                    'register',
                    'Register',
                    registerCount,
                    registerCount > 0 ? 'pass' : 'idle',
                    registerCount ? `${registerCount} agent scope(s)` : 'Awaiting rigour_agent_register',
                ),
                stage(
                    'scope',
                    'Context scope',
                    scopeCount,
                    scopeCount > 0 ? 'pass' : registerCount > 0 ? 'warn' : 'idle',
                    scopeCount ? `${scopeCount} scope event(s)` : 'Call rigour_context_scope / recall',
                ),
                stage(
                    'gates',
                    'Gates',
                    gateCount,
                    gateBlocked > 0 ? 'block' : gateCount > 0 ? 'pass' : 'idle',
                    gateBlocked > 0
                        ? `${gateBlocked} block/intercept event(s)`
                        : gateCount
                          ? 'Gates exercised'
                          : 'Hooks & quality gates idle',
                ),
                stage(
                    'checkpoint',
                    'Checkpoint',
                    checkpointCount,
                    checkpointCount > 0 ? 'pass' : 'idle',
                    checkpointCount ? `${checkpointCount} checkpoint(s)` : 'Awaiting rigour_checkpoint',
                ),
                stage(
                    'handoff',
                    'Handoff',
                    handoffCount,
                    handoffCount > 0 ? (acceptedHandoffs > 0 ? 'pass' : 'warn') : 'idle',
                    handoffCount
                        ? `${acceptedHandoffs}/${handoffCount} accepted`
                        : 'Awaiting rigour_handoff',
                ),
                stage(
                    'memory',
                    'Memory',
                    memoryCount,
                    memoryCount > 0 ? 'pass' : 'idle',
                    memoryCount ? `${memoryCount} stable memor(ies)` : 'Awaiting rigour_remember',
                ),
            ];

            const timeline = events
                .filter((e) =>
                    [
                        'agent_registered',
                        'checkpoint_recorded',
                        'handoff_initiated',
                        'handoff_accepted',
                        'gate_failed',
                        'gate_passed',
                        'hook_blocked',
                        'interception_requested',
                        'memory_stored',
                    ].includes(e.type),
                )
                .slice(-40)
                .reverse()
                .map((e) => ({
                    type: e.type,
                    timestamp: e.timestamp || e.ts || null,
                    agentId: e.agentId || e.fromAgentId || null,
                    summary: e.summary || e.taskDescription || e.tool || e.type,
                }));

            sendJson(res, 200, {
                stages,
                timeline,
                derived: Boolean(agentsSession.derived),
                agentCount: agentsSession.agents?.length || 0,
                sessionStatus: agentsSession.status,
            });
        } catch (e: any) {
            sendJson(res, 500, { error: e.message });
        }
        return true;
    }

    if (url.pathname === '/api/import-cursor-usage' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', async () => {
            try {
                const { importCursorUsageCsv, importCursorUsageJson } = await import('@rigour-labs/core');
                let importedCount = 0;
                if (body.trim().startsWith('{') || body.trim().startsWith('[')) {
                    importedCount = await importCursorUsageJson(JSON.parse(body), cwd);
                } else {
                    importedCount = await importCursorUsageCsv(body, cwd);
                }
                sendJson(res, 200, { success: true, importedCount });
            } catch (e: any) {
                sendJson(res, 500, { error: e.message });
            }
        });
        return true;
    }

    if (url.pathname === '/api/firewall') {
        try {
            const {
                loadCurrentTransaction,
                listTransactions,
                loadLatestAttestation,
                verifyAttestation,
            } = await import('@rigour-labs/core');
            const current = await loadCurrentTransaction(cwd);
            const transactions = await listTransactions(cwd);
            const attestation = await loadLatestAttestation(cwd);
            const attestationValid = attestation ? await verifyAttestation(cwd, attestation) : false;
            const advPath = path.join(cwd, '.rigour/adversarial-report.json');
            const adversarial = await fs.pathExists(advPath) ? await fs.readJson(advPath) : null;
            const decisionsPath = path.join(cwd, '.rigour/firewall-decisions.jsonl');
            let decisions: any[] = [];
            if (await fs.pathExists(decisionsPath)) {
                const content = await fs.readFile(decisionsPath, 'utf8');
                decisions = content
                    .split('\n')
                    .filter((l) => l.trim())
                    .slice(-100)
                    .map((l) => {
                        try {
                            return JSON.parse(l);
                        } catch {
                            return null;
                        }
                    })
                    .filter(Boolean)
                    .reverse();
            }
            let recentDenies: any[] = [];
            if (await fs.pathExists(eventsPath)) {
                const content = await fs.readFile(eventsPath, 'utf8');
                recentDenies = content
                    .split('\n')
                    .filter((l) => l.trim())
                    .map((l) => {
                        try {
                            return JSON.parse(l);
                        } catch {
                            return null;
                        }
                    })
                    .filter((e) => e && (e.type === 'firewall_deny' || e.decision === 'timeout-deny' || e.decision === 'deny'))
                    .slice(-50)
                    .reverse();
            }
            const hooksPresent =
                (await fs.pathExists(path.join(cwd, '.cursor/hooks.json'))) ||
                (await fs.pathExists(path.join(cwd, '.claude/settings.json'))) ||
                (await fs.pathExists(path.join(cwd, '.clinerules'))) ||
                (await fs.pathExists(path.join(cwd, '.windsurf/hooks.json')));
            const agentScopesPath = path.join(cwd, '.rigour/agent-session.json');
            const agentSession = await fs.pathExists(agentScopesPath) ? await fs.readJson(agentScopesPath) : null;
            const scopeActive = Array.isArray(agentSession?.agents) && agentSession.agents.length > 0;
            const typedSeen = recentDenies.some((e) => e.ruleId?.startsWith?.('shell.') || e.tool === 'rigour_run');
            const gatewayWired = false; // McpGateway not yet the MCP proxy path

            sendJson(res, 200, {
                current,
                transactions: transactions.slice(0, 20),
                attestation,
                attestationValid,
                adversarial,
                decisions,
                recentDenies,
                failClosed: true,
                mediation: {
                    status: gatewayWired && hooksPresent ? 'full' : 'partial',
                    typedCommands: typedSeen || hooksPresent ? 'rigour_run_only' : 'not_observed',
                    scopeEnforcement: scopeActive ? 'requires_agent_id' : 'inactive',
                    arbitration: 'fail-closed',
                    hooksInstalled: hooksPresent,
                    mcpGateway: gatewayWired,
                },
            });
        } catch (e: any) {
            sendJson(res, 500, { error: e.message });
        }
        return true;
    }

    if (url.pathname === '/api/arbitrate' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', async () => {
            try {
                const decision = JSON.parse(body);
                const { consumeArbitrationToken } = await import('@rigour-labs/core');
                const ok = await consumeArbitrationToken(cwd, decision.requestId, decision.token);
                if (!ok) {
                    sendJson(res, 403, { error: 'Invalid or missing arbitration token (one-time, fail-closed)' });
                    return;
                }
                const logEntry =
                    JSON.stringify({
                        id: randomUUID(),
                        timestamp: new Date().toISOString(),
                        tool: 'human_arbitration',
                        requestId: decision.requestId,
                        decision: decision.decision,
                        status: decision.decision === 'approve' ? 'success' : 'error',
                        arbitrated: true,
                    }) + '\n';
                await fs.appendFile(eventsPath, logEntry);
                sendJson(res, 200, { success: true });
            } catch (e: any) {
                res.writeHead(500);
                res.end(e.message);
            }
        });
        return true;
    }

    res.writeHead(404);
    res.end();
    return true;
}

async function serveStaticFile(studioDist: string, pathname: string, res: ServerResponse): Promise<void> {
    let filePath = path.join(studioDist, pathname === '/' ? 'index.html' : pathname);
    if (!(await fs.pathExists(filePath)) || (await fs.stat(filePath)).isDirectory()) {
        filePath = path.join(studioDist, 'index.html');
    }
    const content = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    const contentTypes: Record<string, string> = {
        '.html': 'text/html',
        '.js': 'application/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon',
    };
    res.writeHead(200, { 'Content-Type': contentTypes[ext] || 'application/octet-stream' });
    res.end(content);
}

function announce(url: string): void {
    setTimeout(async () => {
        console.log(chalk.green(`\n✅ Rigour Studio is live at ${chalk.bold(url)}`));
        try {
            await execa('open', [url]);
        } catch {
            // non-mac or open unavailable
        }
    }, 800);
}

export const studioCommand = new Command('studio')
    .description('Launch Rigour Studio (Local-First Governance UI)')
    .option('-p, --port <number>', 'Port to run the studio on', '3000')
    .option('--dev', 'Opt-in: run Vite against monorepo studio source (developers only)', false)
    .action(async (options) => {
        const cwd = process.cwd();
        const studioPort = String(options.port);
        const apiPort = parseInt(studioPort, 10) + 1;
        const eventsPath = path.join(cwd, '.rigour/events.jsonl');
        const __dirname = path.dirname(new URL(import.meta.url).pathname);
        const candidates = [
            path.join(__dirname, '../studio-dist'),
            path.join(__dirname, '../../studio-dist'),
            path.join(__dirname, '../../../studio-dist'),
        ];
        const localStudioDist = candidates.find((p) => fs.pathExistsSync(p)) ?? candidates[0];
        const workspaceRoot = path.join(__dirname, '../../../../');
        const allowedOrigins = new Set([
            `http://localhost:${studioPort}`,
            `http://127.0.0.1:${studioPort}`,
        ]);
        const ctx: StudioContext = { cwd, eventsPath, allowedOrigins };

        console.log(chalk.bold.cyan('\n🛡️ Launching Rigour Studio...'));
        console.log(chalk.gray(`Project Root: ${cwd}`));

        const configPath = path.join(cwd, 'rigour.yml');
        if (!(await fs.pathExists(configPath))) {
            console.log(chalk.yellow('\n⚠️ Warning: rigour.yml not found.'));
            console.log(chalk.dim('The Studio will be empty until you initialize the project.'));
            console.log(chalk.cyan('Suggest: ') + chalk.bold('npx @rigour-labs/cli init') + '\n');
        }

        console.log(chalk.gray(`Shadowing interactions in ${eventsPath}\n`));

        const isMonorepo = await fs.pathExists(path.join(workspaceRoot, 'packages/rigour-studio'));

        if (isMonorepo && options.dev) {
            console.log(chalk.yellow('Monorepo detected: Launching Studio in Development Mode...'));
            console.log(chalk.gray(`Vite :${studioPort} → API :${apiPort} (same-origin via proxy)`));
            try {
                const studioProcess = execa(
                    'pnpm',
                    ['--filter', '@rigour-labs/studio', 'dev', '--port', studioPort],
                    {
                        stdio: 'inherit',
                        cwd: workspaceRoot,
                        env: {
                            ...process.env,
                            RIGOUR_API_PORT: String(apiPort),
                        },
                    },
                );

                const apiServer = http.createServer(async (req, res) => {
                    const url = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
                    const handled = await handleApiRequest(req, res, url, ctx);
                    if (!handled) {
                        res.writeHead(404);
                        res.end();
                    }
                });
                apiServer.listen(apiPort, '127.0.0.1', () => {
                    console.log(chalk.gray(`API Streamer active on 127.0.0.1:${apiPort}`));
                });
                announce(`http://127.0.0.1:${studioPort}`);
                await studioProcess;
                return;
            } catch {
                console.log(chalk.dim('Development mode failed, falling back to standalone...'));
            }
        }

        console.log(chalk.green('Launching Studio in Standalone Mode (same-origin API)...'));
        if (!(await fs.pathExists(localStudioDist))) {
            console.error(chalk.red(`\n❌ Error: Studio UI artifacts not found at ${localStudioDist}`));
            console.log(chalk.yellow('If you are a developer, run "pnpm build" in the monorepo root first.\n'));
            process.exit(1);
        }

        // Critical UX fix: serve UI + /api on ONE port so fetch('/api/...') works.
        // Bind loopback only — Studio can accept optional vendor secrets locally.
        const server = http.createServer(async (req, res) => {
            const url = new URL(req.url || '', `http://${req.headers.host || '127.0.0.1'}`);
            try {
                if (await handleApiRequest(req, res, url, ctx)) return;
                await serveStaticFile(localStudioDist, url.pathname, res);
            } catch (e: any) {
                res.writeHead(500);
                res.end(e.message || 'Internal error');
            }
        });

        server.listen(parseInt(studioPort, 10), '127.0.0.1', () => {
            console.log(chalk.gray(`Studio + API on 127.0.0.1:${studioPort}`));
            announce(`http://127.0.0.1:${studioPort}`);
        });
    });
