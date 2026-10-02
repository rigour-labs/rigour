import chalk from 'chalk';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { cleanContextCache, deadCacheRows, loadSettings, resolveDeepOptions, getCachedModel, SidecarProvider } from '@rigour-labs/core';
import { checkRepoSetup, type SetupState } from './repo-setup.js';

function runText(command: string, args: string[]): string {
    try {
        return execFileSync(command, args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
        return '';
    }
}

function listRigourPaths(): string[] {
    if (process.platform === 'win32') {
        const output = runText('where', ['rigour']);
        return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    }
    const output = runText('which', ['-a', 'rigour']);
    return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function getRigourVersionFromPath(binaryPath: string): string {
    try {
        const output = execFileSync(binaryPath, ['--version'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        return output.split(/\r?\n/)[0]?.trim() || 'unknown';
    } catch {
        return 'unknown';
    }
}

export function detectInstallKind(binaryPath: string): string {
    const normalizedInput = binaryPath.replace(/\\/g, '/');
    let resolved = binaryPath;
    try {
        resolved = fs.realpathSync(binaryPath);
    } catch {
        // Keep original path
    }
    const normalizedResolved = resolved.replace(/\\/g, '/');

    const homebrewSignals = [
        '/Cellar/rigour/',
        '/opt/rigour/',
        '/opt/homebrew/bin/rigour',
        '/usr/local/bin/rigour',
    ];
    if (homebrewSignals.some((signal) => normalizedInput.includes(signal) || normalizedResolved.includes(signal))) {
        return 'homebrew';
    }

    if (normalizedInput.includes('@rigour-labs') || normalizedInput.includes('node_modules') ||
        normalizedResolved.includes('@rigour-labs') || normalizedResolved.includes('node_modules')) {
        return 'npm';
    }
    return 'unknown';
}

export function hasVersionShadowing(versions: string[]): boolean {
    const normalized = versions.map((v) => v.trim()).filter((v) => v.length > 0);
    return new Set(normalized).size > 1;
}

export async function doctorCommand(options: { cleanCache?: boolean } = {}, cwd = process.cwd()): Promise<void> {
    console.log(chalk.bold.cyan('\nRigour Doctor\n'));
    if (options.cleanCache) return cleanCache();
    await printRepoSetup(cwd);
    await printDatabaseHealth();

    const paths = Array.from(new Set(listRigourPaths()));
    if (paths.length === 0) {
        console.log(chalk.red('✘ rigour not found in PATH'));
        console.log(chalk.dim('  Install with: npm i -g @rigour-labs/cli OR brew install rigour-labs/tap/rigour\n'));
        return;
    }

    console.log(chalk.bold('CLI Path Check'));
    const entries = paths.map((p) => ({
        path: p,
        version: getRigourVersionFromPath(p),
        kind: detectInstallKind(p),
    }));
    entries.forEach((entry, index) => {
        const active = index === 0 ? chalk.green(' (active)') : '';
        console.log(`  - ${entry.path} ${chalk.dim(`[${entry.kind}] v${entry.version}`)}${active}`);
    });

    const distinctVersions = Array.from(new Set(entries.map((entry) => entry.version)));
    if (entries.length > 1 && hasVersionShadowing(distinctVersions)) {
        console.log(chalk.yellow('\n⚠ Multiple rigour binaries with different versions detected.'));
        console.log(chalk.dim('  This can shadow upgrades and cause "still old version" confusion.'));
        if (process.platform === 'win32') {
            console.log(chalk.dim('  Run: where rigour'));
        } else {
            console.log(chalk.dim('  Run: which -a rigour'));
        }
        console.log(chalk.dim('  Keep one install channel active (brew or npm global), then relink PATH order.\n'));
    } else {
        console.log(chalk.green('  ✓ PATH order/version state looks consistent.\n'));
    }

    console.log(chalk.bold('Deep Mode Readiness'));
    const settings = loadSettings();
    const resolved = resolveDeepOptions({});
    const defaultProvider = resolved.provider || settings.deep?.defaultProvider || 'anthropic';
    const defaultIsCloud = !!resolved.apiKey && defaultProvider !== 'local';
    const hasAnyApiKey = !!(settings.providers && Object.keys(settings.providers).some((k) => !!settings.providers?.[k]));

    console.log(`  - API keys configured: ${hasAnyApiKey ? chalk.green('yes') : chalk.yellow('no')}`);
    console.log(`  - Deep default provider: ${chalk.cyan(defaultProvider)}`);
    if (defaultIsCloud) {
        console.log(chalk.yellow(`  ⚠ Deep defaults to cloud (${defaultProvider}) when you run \`rigour check --deep\`.`));
        console.log(chalk.dim('    Force local any time with: rigour check --deep --provider local'));
    } else {
        console.log(chalk.green('  ✓ Deep defaults to local execution.'));
    }

    // "ready" means the binary ran `--version`, not merely that a file exists.
    const engine = await new SidecarProvider('lite').findEngine();
    const liteModel = await getCachedModel('lite');
    const deepModel = await getCachedModel('deep');
    console.log(`  - Local inference engine: ${engine
        ? chalk.green(`ready (llama.cpp ${engine.version ?? 'unknown version'}) ${chalk.dim(engine.path)}`)
        : chalk.yellow('missing')}`);
    console.log(`  - Local lite model: ${liteModel ? chalk.green(`ready (${liteModel.info.name})`) : chalk.yellow('not cached')}`);
    console.log(`  - Local deep model: ${deepModel ? chalk.green(`ready (${deepModel.info.name})`) : chalk.dim('not cached')}`);

    if (!engine || !liteModel) {
        console.log(chalk.dim('\n  Local bootstrap command: rigour deep pull   (add --pro for the full model)'));
    }

    const rigourHome = path.join(os.homedir(), '.rigour');
    console.log(chalk.dim(`  Rigour home: ${rigourHome}\n`));

    console.log(chalk.bold('Recommended Baseline'));
    console.log(chalk.dim('  1) rigour doctor'));
    console.log(chalk.dim('  2) rigour deep pull [--pro]'));
    console.log(chalk.dim('  3) rigour check <changed files> --deep'));
    console.log(chalk.dim('  4) rigour check --deep -k <KEY> --provider <name>'));
    console.log('');
}

const MARK: Record<SetupState, string> = { working: chalk.green('✓'), 'set up': chalk.yellow('○'), broken: chalk.red('✘'), missing: chalk.yellow('○') };

/** This repository first: is each part of Rigour wired up, and did it fire this week. */
export async function printRepoSetup(cwd: string): Promise<void> {
    console.log(chalk.bold('This repository'));
    for (const check of await checkRepoSetup(cwd)) {
        console.log(`  ${MARK[check.state]} ${check.name}: ${chalk.dim(check.detail)}`);
        if (check.fix && check.state !== 'working') console.log(chalk.dim(`      fix: ${check.fix}`));
    }
    console.log('');
}

const GB = 1024 ** 3;
const size = (bytes: number) => (bytes >= GB ? `${(bytes / GB).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`);

/** The database's size, and the cache rows nothing reads any more, with the command that removes them. */
async function printDatabaseHealth(): Promise<void> {
    const dead = await deadCacheRows().catch(() => null);
    if (!dead) return;
    console.log(chalk.bold('Rigour database'));
    if (dead.rows === 0) {
        console.log(chalk.green(`  ✓ ${size(dead.bytes)}, no unused cache rows\n`));
        return;
    }
    console.log(chalk.yellow(`  ○ ${size(dead.bytes)}, of which ${dead.rows.toLocaleString()} cache rows Rigour no longer reads`));
    console.log(chalk.dim('      fix: rigour doctor --clean-cache   (stop rigour studio first)\n'));
}

async function cleanCache(): Promise<void> {
    console.log(chalk.bold('Cleaning the context cache'));
    const report = await cleanContextCache();
    if (report.removed === 0) {
        console.log(chalk.green(`  ✓ Nothing to remove (${size(report.sizeBefore)})\n`));
        return;
    }
    console.log(chalk.green(`  ✓ Removed ${report.removed.toLocaleString()} unused rows; kept ${report.kept.toLocaleString()}`));
    console.log(report.vacuumed
        ? chalk.green(`  ✓ Database ${size(report.sizeBefore)} → ${size(report.sizeAfter)}\n`)
        : chalk.yellow(`  ○ File not shrunk: ${report.vacuumSkipped}\n`));
}
