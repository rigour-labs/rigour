/**
 * rigour demo
 *
 * Creates a temp project with intentional AI-generated code issues,
 * runs Rigour against it, and shows the full experience.
 * @since v2.17.0 (extended v3.0.0)
 */

import path from 'path';
import fs from 'fs-extra';
import os from 'os';
import chalk from 'chalk';
import type { DemoOptions } from './demo-helpers.js';
export type { DemoOptions } from './demo-helpers.js';
import { pause, typewrite } from './demo-helpers.js';
import { printBanner, printPlantedIssues, printClosing } from './demo-display.js';
import { runHooksDemo, runFullGates, runBeforeAfterDemo, scaffoldDemoProject } from './demo-scenarios.js';

// ── Main demo command ───────────────────────────────────────────────

export async function demoCommand(options: DemoOptions = {}) {
    const isCinematic = !!options.cinematic;
    const showHooks = !!options.hooks || isCinematic;

    printBanner(isCinematic);

    if (isCinematic) {
        await typewrite(
            chalk.bold('Rigour Demo — Watch AI code governance in real time.\n'),
            options
        );
        await pause(800, options);
    } else {
        console.log(chalk.bold('Rigour Demo — See AI code governance in action.\n'));
    }

    // 1. Create temp project
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

    // 2. Simulate AI agent writing flawed code (cinematic/hooks mode)
    if (showHooks) {
        await runHooksDemo(demoDir, options);
    } else {
        printPlantedIssues();
    }

    // 3. Run full quality gates
    await runFullGates(demoDir, options);

    // 4. Show "after fix" improvement (cinematic only)
    if (isCinematic) {
        await runBeforeAfterDemo(demoDir, options);
    }

    // 5. Closing
    printClosing(isCinematic);
}

