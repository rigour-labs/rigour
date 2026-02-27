import chalk from 'chalk';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { loadSettings, resolveDeepOptions, isModelCached, createProvider } from '@rigour-labs/core';

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

export async function doctorCommand(): Promise<void> {
    console.log(chalk.bold.cyan('\nRigour Doctor\n'));

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

    const provider = createProvider({ enabled: true, provider: 'local' } as any);
    const sidecarAvailable = await provider.isAvailable();
    provider.dispose();
    const deepModelCached = await isModelCached('deep');
    const proModelCached = await isModelCached('pro');
    console.log(`  - Local inference binary: ${sidecarAvailable ? chalk.green('ready') : chalk.yellow('missing')}`);
    console.log(`  - Local deep model cache: ${deepModelCached ? chalk.green('ready') : chalk.yellow('not cached')}`);
    console.log(`  - Local pro model cache: ${proModelCached ? chalk.green('ready') : chalk.dim('not cached')}`);

    if (!sidecarAvailable || !deepModelCached) {
        console.log(chalk.dim('\n  Local bootstrap command: rigour check --deep --provider local'));
    }

    const rigourHome = path.join(os.homedir(), '.rigour');
    console.log(chalk.dim(`  Rigour home: ${rigourHome}\n`));

    console.log(chalk.bold('Recommended Baseline'));
    console.log(chalk.dim('  1) rigour doctor'));
    console.log(chalk.dim('  2) rigour check --deep --provider local'));
    console.log(chalk.dim('  3) rigour check --deep -k <KEY> --provider <name>'));
    console.log('');
}
