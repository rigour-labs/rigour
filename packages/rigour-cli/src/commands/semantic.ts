/**
 * The local embedding library, installed once per machine into Rigour's home (core
 * pattern-index/semantic-runtime.ts), so recall and "is there already a helper for this?" work by
 * meaning. `rigour setup` installs it unless asked not to, or the disk is too full; nothing else
 * ever does, so a hook or an MCP call never waits on a download.
 */
import chalk from 'chalk';
import { execa } from 'execa';
import fs from 'fs';
import path from 'path';
import { locateTransformers, semanticRuntimeDir, TRANSFORMERS_SPEC } from '@rigour-labs/core';

/** What the library takes on disk, with room to spare for npm's own cache while it installs. */
const NEEDED_BYTES = 1024 ** 3;
const INSTALL_TIMEOUT_MS = 10 * 60_000;

type SemanticInstall = { state: 'present'; where: string } | { state: 'installed'; where: string } | { state: 'skipped' | 'failed'; reason: string };

async function ensureSemanticRuntime(cwd: string): Promise<SemanticInstall> {
    const found = locateTransformers(cwd);
    if (found) return { state: 'present', where: found };
    const dir = semanticRuntimeDir();
    fs.mkdirSync(dir, { recursive: true });
    const free = freeBytes(dir);
    if (free !== undefined && free < NEEDED_BYTES) return { state: 'skipped', reason: `only ${Math.round(free / 1024 ** 2)} MB free; it needs about 1 GB while installing` };
    if (!fs.existsSync(path.join(dir, 'package.json'))) fs.writeFileSync(path.join(dir, 'package.json'), '{ "name": "rigour-semantic-runtime", "private": true }\n');
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const result = await execa(npm, ['install', '--no-audit', '--no-fund', '--omit=dev', TRANSFORMERS_SPEC], { cwd: dir, reject: false, timeout: INSTALL_TIMEOUT_MS });
    if (result.exitCode !== 0) return { state: 'failed', reason: String(result.stderr || result.stdout || `npm exited ${result.exitCode}`).trim().split('\n').slice(-3).join(' ') };
    const where = locateTransformers(cwd);
    return where ? { state: 'installed', where } : { state: 'failed', reason: `npm finished, but ${TRANSFORMERS_SPEC} does not resolve from ${dir}` };
}

function freeBytes(dir: string): number | undefined {
    try {
        const stats = fs.statfsSync(dir);
        return Number(stats.bavail) * Number(stats.bsize);
    } catch {
        return undefined;
    }
}

/** The setup step, as a person reads it. */
export async function setupSemantic(cwd: string): Promise<void> {
    if (locateTransformers(cwd)) {
        console.log(chalk.green('✔ Semantic search is on (local embeddings)'));
        return;
    }
    console.log(chalk.dim('Installing semantic search: about 230 MB, once for every Rigour version on this machine (skip with --no-semantic)...'));
    const result = await ensureSemanticRuntime(cwd);
    if (result.state === 'installed' || result.state === 'present') console.log(chalk.green('✔ Semantic search is on (local embeddings)'));
    else console.log(chalk.yellow(`Semantic search is off (${result.reason}). Recall and pattern matching use keywords until \`rigour setup\` runs again.`));
}

/** The doctor line. */
export function semanticStatusLine(cwd: string): string {
    const where = locateTransformers(cwd);
    return where
        ? chalk.green(`  ✓ Semantic search: on (${where.includes(semanticRuntimeDir()) ? "Rigour's shared copy" : 'installed with Rigour or the project'})`)
        : chalk.yellow('  ⚠ Semantic search: off. Recall and pattern matching use keywords, which find far less. Run: rigour setup');
}
