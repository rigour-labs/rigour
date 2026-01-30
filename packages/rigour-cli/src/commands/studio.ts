import { Command } from 'commander';
import path from 'path';
import chalk from 'chalk';
import { execa } from 'execa';
import fs from 'fs-extra';
import http from 'http';
import { randomUUID } from 'crypto';

export const studioCommand = new Command('studio')
    .description('Launch Rigour Studio (Local-First Governance UI)')
    .option('-p, --port <number>', 'Port to run the studio on', '3000')
    .option('--dev', 'Run in development mode', true)
    .action(async (options) => {
        const cwd = process.cwd();
        const apiPort = parseInt(options.port) + 1;
        const eventsPath = path.join(cwd, '.rigour/events.jsonl');

        // Calculate the local dist path (where the pre-built Studio UI lives)
        const __dirname = path.dirname(new URL(import.meta.url).pathname);
        const localStudioDist = path.join(__dirname, '../studio-dist');
        const workspaceRoot = path.join(__dirname, '../../../../');

        console.log(chalk.bold.cyan('\n🛡️ Launching Rigour Studio...'));
        console.log(chalk.gray(`Project Root: ${cwd}`));

        // Pre-flight check: Is the project initialized?
        const configPath = path.join(cwd, 'rigour.yml');
        if (!(await fs.pathExists(configPath))) {
            console.log(chalk.yellow('\n⚠️ Warning: rigour.yml not found.'));
            console.log(chalk.dim('The Studio will be empty until you initialize the project.'));
            console.log(chalk.cyan('Suggest: ') + chalk.bold('npx @rigour-labs/cli init') + '\n');
        }

        console.log(chalk.gray(`Shadowing interactions in ${path.join(cwd, '.rigour/events.jsonl')}\n`));

        // Check if we are in a monorepo development environment
        const isMonorepo = await fs.pathExists(path.join(workspaceRoot, 'packages/rigour-studio'));

        if (isMonorepo && options.dev) {
            console.log(chalk.yellow('Monorepo detected: Launching Studio in Development Mode...'));
            try {
                // Start the Studio dev server in the workspace root
                const studioProcess = execa('pnpm', ['--filter', '@rigour-labs/studio', 'dev', '--port', options.port], {
                    stdio: 'inherit',
                    shell: true,
                    cwd: workspaceRoot
                });

                await setupApiAndLaunch(apiPort, options.port, eventsPath, cwd, studioProcess);
                return;
            } catch (e) {
                console.log(chalk.dim('Development mode failed, falling back to standalone...'));
            }
        }

        // Standalone Mode: Serve pre-built static files
        console.log(chalk.green('Launching Studio in Standalone Mode...'));
        if (!(await fs.pathExists(localStudioDist))) {
            console.error(chalk.red(`\n❌ Error: Studio UI artifacts not found at ${localStudioDist}`));
            console.log(chalk.yellow('If you are a developer, run "pnpm build" in the monorepo root first.\n'));
            process.exit(1);
        }

        const staticServer = http.createServer(async (req, res) => {
            const url = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
            let filePath = path.join(localStudioDist, url.pathname === '/' ? 'index.html' : url.pathname);

            try {
                if (!(await fs.pathExists(filePath)) || (await fs.stat(filePath)).isDirectory()) {
                    filePath = path.join(localStudioDist, 'index.html');
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
                    '.ico': 'image/x-icon'
                };

                res.writeHead(200, { 'Content-Type': contentTypes[ext] || 'application/octet-stream' });
                res.end(content);
            } catch (e) {
                res.writeHead(404);
                res.end('Not Found');
            }
        });

        staticServer.listen(options.port, () => {
            setupApiAndLaunch(apiPort, options.port, eventsPath, cwd);
        });
    });

async function setupApiAndLaunch(apiPort: number, studioPort: string, eventsPath: string, cwd: string, studioProcess?: any) {
    const apiServer = http.createServer(async (req, res) => {
        const url = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);

        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS, POST');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        if (url.pathname === '/api/events') {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive'
            });

            if (await fs.pathExists(eventsPath)) {
                const content = await fs.readFile(eventsPath, 'utf8');
                const lines = content.split('\n').filter(l => l.trim());
                for (const line of lines) {
                    res.write(`data: ${line}\n\n`);
                }
            }

            await fs.ensureDir(path.dirname(eventsPath));
            const watcher = fs.watch(path.dirname(eventsPath), (eventType, filename) => {
                if (filename === 'events.jsonl') {
                    fs.readFile(eventsPath, 'utf8').then(content => {
                        const lines = content.split('\n').filter(l => l.trim());
                        const lastLine = lines[lines.length - 1];
                        if (lastLine) {
                            res.write(`data: ${lastLine}\n\n`);
                        }
                    }).catch(() => { });
                }
            });

            req.on('close', () => watcher.close());
        } else if (url.pathname === '/api/file') {
            const filePath = url.searchParams.get('path');
            if (!filePath) {
                res.writeHead(400); res.end('Missing path'); return;
            }
            const absolutePath = path.resolve(cwd, filePath);
            if (!absolutePath.startsWith(cwd)) {
                res.writeHead(403); res.end('Forbidden'); return;
            }
            try {
                const content = await fs.readFile(absolutePath, 'utf8');
                res.writeHead(200, { 'Content-Type': 'text/plain' });
                res.end(content);
            } catch {
                res.writeHead(404); res.end('Not found');
            }
        } else if (url.pathname === '/api/info') {
            try {
                const pkgPath = path.join(cwd, 'package.json');
                const pkg = await fs.pathExists(pkgPath) ? await fs.readJson(pkgPath) : {};
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    name: pkg.name || path.basename(cwd),
                    path: cwd,
                    version: pkg.version || '0.0.0'
                }));
            } catch (e: any) {
                res.writeHead(500); res.end(e.message);
            }
        } else if (url.pathname === '/api/tree') {
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
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(await getTree(cwd)));
            } catch (e: any) {
                res.writeHead(500); res.end(e.message);
            }
        } else if (url.pathname === '/api/config') {
            try {
                const configPath = path.join(cwd, 'rigour.yml');
                if (await fs.pathExists(configPath)) {
                    res.writeHead(200, { 'Content-Type': 'text/plain' });
                    res.end(await fs.readFile(configPath, 'utf8'));
                } else {
                    res.writeHead(404); res.end('Not found');
                }
            } catch (e: any) {
                res.writeHead(500); res.end(e.message);
            }
        } else if (url.pathname === '/api/memory') {
            try {
                const memoryPath = path.join(cwd, '.rigour/memory.json');
                if (await fs.pathExists(memoryPath)) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(await fs.readFile(memoryPath, 'utf8'));
                } else {
                    res.end(JSON.stringify({}));
                }
            } catch (e: any) {
                res.writeHead(500); res.end(e.message);
            }
        } else if (url.pathname === '/api/index-stats') {
            try {
                const indexPath = path.join(cwd, '.rigour/patterns.json');
                if (await fs.pathExists(indexPath)) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(await fs.readJson(indexPath)));
                } else {
                    res.end(JSON.stringify({ patterns: [], stats: { totalPatterns: 0, totalFiles: 0, byType: {} } }));
                }
            } catch (e: any) {
                res.writeHead(500); res.end(e.message);
            }
        } else if (url.pathname === '/api/index-search') {
            const query = url.searchParams.get('q');
            if (!query) {
                res.writeHead(400); res.end('Missing query'); return;
            }
            try {
                const { generateEmbedding, semanticSearch } = await import('@rigour-labs/core/pattern-index');
                const indexPath = path.join(cwd, '.rigour/patterns.json');
                const indexData = await fs.readJson(indexPath);
                const queryVector = await generateEmbedding(query);
                const similarities = semanticSearch(queryVector, indexData.patterns);
                const results = indexData.patterns.map((p: any, i: number) => ({ ...p, similarity: similarities[i] }))
                    .filter((p: any) => p.similarity > 0.3)
                    .sort((a: any, b: any) => b.similarity - a.similarity)
                    .slice(0, 20);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(results));
            } catch (e: any) {
                res.writeHead(500); res.end(e.message);
            }
        } else if (url.pathname === '/api/arbitrate' && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', async () => {
                try {
                    const decision = JSON.parse(body);
                    const logEntry = JSON.stringify({
                        id: randomUUID(),
                        timestamp: new Date().toISOString(),
                        tool: 'human_arbitration',
                        requestId: decision.requestId,
                        decision: decision.decision,
                        status: decision.decision === 'approve' ? 'success' : 'error',
                        arbitrated: true
                    }) + "\n";
                    await fs.appendFile(eventsPath, logEntry);
                    res.writeHead(200);
                    res.end(JSON.stringify({ success: true }));
                } catch (e: any) {
                    res.writeHead(500); res.end(e.message);
                }
            });
        } else {
            res.writeHead(404);
            res.end();
        }
    });

    apiServer.listen(apiPort, () => {
        console.log(chalk.gray(`API Streamer active on port ${apiPort}`));
    });

    setTimeout(async () => {
        const url = `http://localhost:${studioPort}`;
        console.log(chalk.green(`\n✅ Rigour Studio is live at ${chalk.bold(url)}`));
        try { await execa('open', [url]); } catch { }
    }, 1500);

    if (studioProcess) {
        await studioProcess;
    }
}
