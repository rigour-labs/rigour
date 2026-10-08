import { Command } from 'commander';
import path from 'path';
import chalk from 'chalk';
import { execa } from 'execa';
import fs from 'fs-extra';
import { createReadStream, promises as nativeFs } from 'fs';
import readline from 'readline';
import { spawn, spawnSync } from 'child_process';
import http from 'http';
import type { IncomingMessage, ServerResponse } from 'http';
import { randomUUID } from 'crypto';
import { resolveStudioVersion } from './studio-contracts.js';
import { loadStudioLearnedRules } from './studio-learned-rules.js';
import { loadPrePrReview } from './studio-pre-pr.js';
import { createStudioGuard, refuseStudioRequest, STUDIO_KEY_HEADER, studioLaunchUrl, type StudioGuard } from './studio-guard.js';
import { enabledHere } from './personal.js';
import { rigourUserDir } from '@rigour-labs/core';

type StudioContext = {
    cwd: string;
    eventsPath: string;
    guard: StudioGuard;
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

async function readRecentLines(filePath: string, limit: number): Promise<string[]> {
    const stat = await nativeFs.stat(filePath);
    const bytes = Math.min(stat.size, 512 * 1024);
    const handle = await nativeFs.open(filePath, 'r');
    try {
        const buffer = Buffer.alloc(bytes);
        await handle.read(buffer, 0, bytes, stat.size - bytes);
        return buffer.toString('utf8').split('\n').filter(line => line.trim()).slice(-limit);
    } finally {
        await handle.close();
    }
}

async function mergeMemoryStores(cwd: string): Promise<{ memories: Record<string, any>; sources: string[] }> {
    const sources: string[] = [];
    const memories: Record<string, any> = {};

    const projectPath = path.join(cwd, '.rigour/memory.json');
    // Same home the MCP server writes user-scope memory to (RIGOUR_HOME when set).
    const globalPath = path.join(rigourUserDir(), 'memory.json');

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

async function handleApiRequest(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    ctx: StudioContext,
): Promise<boolean> {
    if (!url.pathname.startsWith('/api')) return false;

    const refusal = refuseStudioRequest(req, ctx.guard);
    if (refusal) {
        sendJson(res, 403, { error: refusal });
        return true;
    }
    const requestOrigin = req.headers.origin;
    if (typeof requestOrigin === 'string' && ctx.guard.allowedOrigins.has(requestOrigin)) {
        res.setHeader('Access-Control-Allow-Origin', requestOrigin);
        res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS, POST, DELETE');
    res.setHeader('Access-Control-Allow-Headers', `Content-Type, ${STUDIO_KEY_HEADER}`);
    res.setHeader('X-Rigour-Api-Version', '1');

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
        res.write(': connected\n\n');

        if (await fs.pathExists(eventsPath)) {
            for (const line of await readRecentLines(eventsPath, 200)) {
                res.write(`data: ${line}\n\n`);
            }
        }

        await fs.ensureDir(path.dirname(eventsPath));
        let lastModified = (await fs.pathExists(eventsPath)) ? (await fs.stat(eventsPath)).mtimeMs : 0;
        let ticks = 0;
        const poller = setInterval(async () => {
            try {
                ticks++;
                if (ticks % 15 === 0) res.write(': heartbeat\n\n');
                if (!(await fs.pathExists(eventsPath))) return;
                const stat = await fs.stat(eventsPath);
                if (stat.mtimeMs <= lastModified) return;
                lastModified = stat.mtimeMs;
                const lastLine = (await readRecentLines(eventsPath, 1)).at(-1);
                if (lastLine) res.write(`data: ${lastLine}\n\n`);
            } catch {
                // A transient read failure must not terminate the event stream.
            }
        }, 1_000);
        req.on('close', () => clearInterval(poller));
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
            let mcpVersion = '';
            for (const candidate of mcpPkgCandidates) {
                if (await fs.pathExists(candidate)) {
                    const mcpPkg = await fs.readJson(candidate);
                    mcpVersion = mcpPkg.version || mcpVersion;
                    break;
                }
            }
            const studioVersion = resolveStudioVersion(cliPkg.version, mcpVersion);
            sendJson(res, 200, {
                name: pkg.name || path.basename(cwd),
                projectName: pkg.name || path.basename(cwd),
                path: cwd,
                projectPath: cwd,
                // null, not a made-up 0.0.0, when the project declares no version
                version: pkg.version || null,
                projectVersion: pkg.version || null,
                branch: currentBranch(cwd),
                teamSync: Boolean(await (await import('@rigour-labs/core')).loadTeamConfiguration()),
                studioVersion,
                mcpVersion,
                brainDb: path.join(rigourUserDir(), 'rigour.db'),
            });
        } catch (e: any) {
            res.writeHead(500);
            res.end(e.message);
        }
        return true;
    }

    if (url.pathname === '/api/learned-rules') {
        try {
            const rules = loadStudioLearnedRules(cwd);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(rules));
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

    if (url.pathname === '/api/health') {
        try {
            const { getSystemHealth } = await import('@rigour-labs/core');
            sendJson(res, 200, await getSystemHealth(cwd));
        } catch (e: any) {
            sendJson(res, 503, { schemaVersion: 1, generatedAt: new Date().toISOString(), error: e.message });
        }
        return true;
    }

    if (url.pathname === '/api/lessons' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', async () => {
            try {
                const payload = JSON.parse(body || '{}');
                const allowedStates = new Set(['validated', 'promoted', 'rejected', 'superseded']);
                if (typeof payload.id !== 'string' || !allowedStates.has(payload.state)) {
                    sendJson(res, 400, { error: 'A lesson id and valid target state are required.' });
                    return;
                }
                const { transitionLesson } = await import('@rigour-labs/core');
                const publishing = payload.state === 'promoted';
                const changed = await transitionLesson(payload.id, payload.state, {
                    visibility: publishing ? 'team' : undefined,
                    queueSync: publishing,
                });
                sendJson(res, changed ? 200 : 404, { success: changed });
            } catch (e: any) {
                sendJson(res, 400, { error: e.message });
            }
        });
        return true;
    }

    if (url.pathname === '/api/index-stats') {
        try {
            const indexPath = path.join(cwd, '.rigour/patterns.json');
            if (await fs.pathExists(indexPath)) {
                // Embeddings are 384 numbers per pattern and the view never draws them.
                const index = await fs.readJson(indexPath);
                sendJson(res, 200, { ...index, patterns: (index.patterns ?? []).map(withoutEmbedding) });
            } else {
                sendJson(res, 200, { patterns: [], stats: { totalPatterns: 0, totalFiles: 0, byType: {} } });
            }
        } catch (e: any) {
            sendJson(res, 500, { error: e.message });
        }
        return true;
    }

    if (url.pathname === '/api/week') {
        try {
            const { loadWeek } = await import('./studio-week.js');
            sendJson(res, 200, loadWeek(cwd));
        } catch (e: any) {
            sendJson(res, 500, { error: e.message });
        }
        return true;
    }

    if (url.pathname === '/api/dismiss' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', async () => {
            try {
                const payload = JSON.parse(body || '{}');
                const reason = typeof payload.reason === 'string' ? payload.reason.trim() : '';
                if (typeof payload.key !== 'string' || !reason) {
                    sendJson(res, 400, { error: 'A finding key and a reason are required.' });
                    return;
                }
                const { dismissFinding } = await import('@rigour-labs/core');
                const ok = dismissFinding(cwd, payload.key, reason);
                sendJson(res, ok ? 200 : 400, ok ? { success: true } : { error: 'Not a finding key.' });
            } catch (e: any) {
                sendJson(res, 400, { error: e.message });
            }
        });
        return true;
    }

    if (url.pathname === '/api/reviewer' && req.method === 'GET') {
        try {
            const { loadStudioReviewer } = await import('./studio-reviewer.js');
            sendJson(res, 200, await loadStudioReviewer(cwd));
        } catch (e: any) {
            sendJson(res, 500, { error: e.message });
        }
        return true;
    }

    if (['/api/reviewer/settings', '/api/reviewer/team', '/api/reviewer/dismiss'].includes(url.pathname) && req.method === 'POST') {
        try {
            const body = JSON.parse((await readBody(req)) || '{}');
            const { saveStudioReviewer, saveTeamReviewer, dismissFromStudio } = await import('./studio-reviewer.js');
            const write = { '/api/reviewer/settings': saveStudioReviewer, '/api/reviewer/team': saveTeamReviewer, '/api/reviewer/dismiss': dismissFromStudio }[url.pathname]!;
            sendJson(res, 200, await write(cwd, body));
        } catch (e: any) {
            sendJson(res, 400, { error: e.message });
        }
        return true;
    }

    const switchPath = /^\/api\/switches\/([a-z]+)$/.exec(url.pathname);
    if (switchPath && (req.method === 'GET' || req.method === 'POST')) {
        try {
            const { loadStudioSwitch, saveStudioSwitch, switchNamed } = await import('./studio-switches.js');
            const name = switchNamed(switchPath[1]);
            if (!name) sendJson(res, 404, { error: `no switch named ${switchPath[1]}` });
            else sendJson(res, 200, req.method === 'GET' ? await loadStudioSwitch(cwd, name) : await saveStudioSwitch(cwd, name, JSON.parse((await readBody(req)) || '{}')));
        } catch (e: any) {
            sendJson(res, req.method === 'GET' ? 500 : 400, { error: e.message });
        }
        return true;
    }

    if (url.pathname === '/api/learning') {
        try {
            const { loadLearning } = await import('./studio-learning.js');
            sendJson(res, 200, await loadLearning(cwd));
        } catch (e: any) {
            sendJson(res, 500, { error: e.message });
        }
        return true;
    }

    if (url.pathname === '/api/progress') {
        try {
            const { loadProgress } = await import('./studio-progress.js');
            sendJson(res, 200, await loadProgress(cwd));
        } catch (e: any) {
            sendJson(res, 500, { error: e.message });
        }
        return true;
    }

    if (url.pathname === '/api/activity') {
        try {
            const { loadActivity } = await import('./studio-activity.js');
            sendJson(res, 200, { sessions: loadActivity(cwd) });
        } catch (e: any) {
            sendJson(res, 500, { error: e.message });
        }
        return true;
    }

    if (url.pathname === '/api/context') {
        try {
            const { loadAgentContext } = await import('./studio-context.js');
            sendJson(res, 200, await loadAgentContext(cwd));
        } catch (e: any) {
            sendJson(res, 500, { error: e.message });
        }
        return true;
    }

    if (url.pathname === '/api/setup') {
        try {
            const { checkRepoSetup } = await import('./repo-setup.js');
            sendJson(res, 200, { checks: await checkRepoSetup(cwd) });
        } catch (e: any) {
            sendJson(res, 500, { error: e.message });
        }
        return true;
    }

    if (url.pathname === '/api/pre-pr-review') {
        try {
            sendJson(res, 200, loadPrePrReview(cwd));
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
                if (decision.decision !== 'approve' && decision.decision !== 'reject') {
                    sendJson(res, 400, { error: 'decision must be approve or reject' });
                    return;
                }
                const { signArbitrationDecision } = await import('@rigour-labs/core');
                const proof = await signArbitrationDecision(cwd, String(decision.requestId ?? ''), decision.decision);
                if (!proof) {
                    sendJson(res, 403, { error: 'Unknown, expired or already decided request (one-time, fail-closed)' });
                    return;
                }
                const logEntry =
                    JSON.stringify({
                        id: randomUUID(),
                        timestamp: new Date().toISOString(),
                        tool: 'human_arbitration',
                        requestId: decision.requestId,
                        decision: decision.decision,
                        proof,
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

const MAX_BODY = 64 * 1024;

/** A request body, whole, and never more than a settings change needs. */
function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => {
            body += chunk;
            if (body.length > MAX_BODY) {
                req.destroy();
                reject(new Error('request body too large'));
            }
        });
        req.on('end', () => resolve(body));
        req.on('error', reject);
    });
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
    // The page is revalidated so an upgraded Rigour serves its new Studio; hashed assets never change.
    const cacheControl = ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable';
    res.writeHead(200, { 'Content-Type': contentTypes[ext] || 'application/octet-stream', 'Cache-Control': cacheControl });
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
    .description('Open Studio: what Rigour stopped, learned and gave your agents')
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
        const guard = createStudioGuard([studioPort, apiPort]);
        const ctx: StudioContext = { cwd, eventsPath, guard };

        const { loadTeamConfiguration, syncTeamOutbox } = await import('@rigour-labs/core');
        // Indexing runs in its own process so the server answers while embeddings are computed.
        spawn(process.execPath, [new URL('./studio-index-worker.js', import.meta.url).pathname, cwd], { stdio: ['ignore', 'ignore', 'inherit'] }).unref();
        const syncTimer = setInterval(() => {
            void loadTeamConfiguration().then((config) => {
                if (config) return syncTeamOutbox().catch(() => undefined);
                return undefined;
            });
        }, 30_000);
        syncTimer.unref();

        console.log(chalk.bold.cyan('\n🛡️ Launching Rigour Studio...'));
        console.log(chalk.gray(`Project Root: ${cwd}`));

        // A personal install has no rigour.yml; only a repository Rigour does not run in at all is empty here.
        if (!(await fs.pathExists(path.join(cwd, 'rigour.yml'))) && !enabledHere(cwd)) {
            console.log(chalk.yellow('\nRigour is not set up in this repository, so Studio has little to show yet.'));
            console.log(chalk.cyan('Set it up: ') + chalk.bold('rigour setup') + chalk.dim(' (nothing goes in your repository)') + '\n');
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
                announce(studioLaunchUrl(`http://127.0.0.1:${studioPort}`, guard));
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
            announce(studioLaunchUrl(`http://127.0.0.1:${studioPort}`, guard));
        });
    });

/** A pattern as Studio shows it: everything but its embedding vector. */
function withoutEmbedding<T extends { embedding?: unknown }>(pattern: T): Omit<T, 'embedding'> {
    const { embedding: _embedding, ...rest } = pattern;
    return rest;
}

/** The checked-out branch, or null outside git or on a detached HEAD. */
function currentBranch(cwd: string): string | null {
    const result = spawnSync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' });
    const branch = result.status === 0 ? result.stdout.trim() : '';
    return branch && branch !== 'HEAD' ? branch : null;
}
