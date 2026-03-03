/**
 * rigour demo
 *
 * Creates a temp project (or clones a real repo) with intentional
 * AI-generated code issues, runs Rigour against it in real time.
 * @since v2.17.0 (extended v3.0.0, repo mode v3.1.0)
 */

import path from 'path';
import fs from 'fs-extra';
import os from 'os';
import chalk from 'chalk';
import { execSync } from 'child_process';
import type { DemoOptions } from './demo-helpers.js';
export type { DemoOptions } from './demo-helpers.js';
import { pause, typewrite } from './demo-helpers.js';
import { printBanner, printPlantedIssues, printClosing, simulateCodeWrite, simulateHookCatch } from './demo-display.js';
import { runHooksDemo, runFullGates, runBeforeAfterDemo, scaffoldDemoProject } from './demo-scenarios.js';
import { TS_INJECTIONS, PYTHON_INJECTIONS, TS_FIXES, detectInjectionSet } from './demo-injections.js';

export async function demoCommand(options: DemoOptions = {}) {
    const isCinematic = !!options.cinematic;
    const showHooks = !!options.hooks || isCinematic;

    printBanner(isCinematic);

    if (options.repo) {
        await runRepoDemo(options);
        return;
    }

    // Original synthetic demo flow
    await runSyntheticDemo(options, isCinematic, showHooks);
}

async function runSyntheticDemo(options: DemoOptions, isCinematic: boolean, showHooks: boolean) {
    if (isCinematic) {
        await typewrite(chalk.bold('Rigour Demo — Watch AI code governance in real time.\n'), options);
        await pause(800, options);
    } else {
        console.log(chalk.bold('Rigour Demo — See AI code governance in action.\n'));
    }

    const demoDir = path.join(os.tmpdir(), `rigour-demo-${Date.now()}`);
    await fs.ensureDir(demoDir);

    if (isCinematic) {
        await typewrite(chalk.dim(`Setting up demo project...`), options);
        await pause(400, options);
    } else {
        console.log(chalk.dim(`Creating demo project at ${demoDir}...\n`));
    }

    await scaffoldDemoProject(demoDir);
    console.log(chalk.green('✓ Demo project scaffolded.\n'));

    if (showHooks) {
        await runHooksDemo(demoDir, options);
    } else {
        printPlantedIssues();
    }

    await runFullGates(demoDir, options);

    if (isCinematic) {
        await runBeforeAfterDemo(demoDir, options);
    }

    printClosing(isCinematic);
}

async function runRepoDemo(options: DemoOptions) {
    const repoUrl = options.repo!;
    const repoName = extractRepoName(repoUrl);

    await typewrite(
        chalk.bold(`Rigour Live Demo — Real repo, real issues, real-time.\n`),
        options,
    );
    await pause(600, options);

    // 1. Clone
    const demoDir = path.join(os.tmpdir(), `rigour-demo-${repoName}-${Date.now()}`);
    await typewrite(chalk.dim(`Cloning ${repoUrl}...`), options);
    if (!/^https?:\/\/[^\s;|&]+$/.test(repoUrl)) {
        console.error(chalk.red('Invalid repo URL. Use https://github.com/owner/repo format.'));
        return;
    }
    execSync(`git clone --depth 1 ${repoUrl} ${demoDir}`, { stdio: 'pipe' });
    console.log(chalk.green(`✓ Cloned ${repoName}\n`));
    await pause(400, options);

    // 2. Detect language, ensure rigour.yml, pick injections
    const isPython = await detectPythonRepo(demoDir);
    const injections = isPython ? PYTHON_INJECTIONS : TS_INJECTIONS;

    // Ensure a rigour.yml exists (real repos may not have one)
    if (!await fs.pathExists(path.join(demoDir, 'rigour.yml'))) {
        const { buildDemoConfig } = await import('./demo-scaffold.js');
        const yaml = await import('yaml');
        await fs.writeFile(path.join(demoDir, 'rigour.yml'), yaml.default.stringify(buildDemoConfig()));
    }

    // 3. Show "AI agent modifying codebase..."
    const divider = chalk.cyan('━'.repeat(50));
    console.log(divider);
    await typewrite(
        chalk.bold.magenta('  Simulating AI agent writing code with hooks active...\n'),
        options,
    );
    await pause(600, options);

    // 4. Inject drift and simulate hook catches
    for (const injection of injections) {
        await injectAndCatch(demoDir, injection, options);
    }

    console.log('');
    console.log(chalk.magenta.bold(
        `  Hooks caught ${injections.length} issues in real time — before the commit.`,
    ));
    console.log(divider);
    console.log('');
    await pause(1000, options);

    // 5. Run full gates
    await runFullGates(demoDir, options);

    // 6. Fix and show improvement (cinematic)
    if (options.cinematic && !isPython) {
        await runRepoBeforeAfter(demoDir, options);
    }

    // 7. Closing
    printClosing(true);
}

async function injectAndCatch(
    demoDir: string,
    injection: import('./demo-injections.js').DriftInjection,
    options: DemoOptions,
): Promise<void> {
    const filePath = path.join(demoDir, injection.filename);
    await fs.ensureDir(path.dirname(filePath));

    console.log(chalk.blue.bold(`  Agent: Write → ${injection.filename}`));
    await simulateCodeWrite(
        injection.filename,
        injection.code.split('\n'),
        options,
    );
    await fs.writeFile(filePath, injection.code);

    await simulateHookCatch(
        injection.gate,
        injection.filename,
        injection.hookMessage,
        injection.severity,
        options,
    );
    console.log('');
}

async function runRepoBeforeAfter(demoDir: string, options: DemoOptions): Promise<void> {
    console.log(chalk.bold.green('Simulating agent fixing issues...\n'));
    await pause(600, options);

    for (const [filename, fixedCode] of Object.entries(TS_FIXES)) {
        await typewrite(chalk.dim(`  Agent: Fixing ${filename}...`), options);
        await fs.writeFile(path.join(demoDir, filename), fixedCode);
        console.log(chalk.green(`  ✓ Fixed: ${filename}`));
        await pause(300, options);
    }

    console.log('');
    await pause(500, options);
    console.log(chalk.bold.blue('Re-running quality gates after fixes...\n'));
    await runFullGates(demoDir, options);
}

function extractRepoName(url: string): string {
    const match = url.match(/([^/]+?)(?:\.git)?$/);
    return match ? match[1] : 'repo';
}

async function detectPythonRepo(dir: string): Promise<boolean> {
    const pyFiles = ['requirements.txt', 'setup.py', 'pyproject.toml', 'Pipfile'];
    for (const f of pyFiles) {
        if (await fs.pathExists(path.join(dir, f))) return true;
    }
    return false;
}
