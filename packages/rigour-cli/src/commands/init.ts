import fs from 'fs-extra';
import path from 'path';
import chalk from 'chalk';
import yaml from 'yaml';
import { DiscoveryService } from '@rigour-labs/core';

export async function initCommand(cwd: string) {
    const discovery = new DiscoveryService();
    const recommendedConfig = await discovery.discover(cwd);

    const configPath = path.join(cwd, 'rigour.yml');

    if (await fs.pathExists(configPath)) {
        console.log(chalk.yellow('rigour.yml already exists. Skipping initialization.'));
        return;
    }

    await fs.writeFile(configPath, yaml.stringify(recommendedConfig));
    console.log(chalk.green('✔ Created rigour.yml'));

    // Create required directories and files
    const requireddocs = recommendedConfig.gates.required_files || [];
    for (const file of requireddocs) {
        const filePath = path.join(cwd, file);
        if (!(await fs.pathExists(filePath))) {
            await fs.ensureFile(filePath);
            console.log(chalk.dim(`  - Created ${file}`));
        }
    }

    // Agent Handshake (Cursor/AntiGravity)
    const cursorRulesDir = path.join(cwd, '.cursor', 'rules');
    await fs.ensureDir(cursorRulesDir);
    const rulePath = path.join(cursorRulesDir, 'rigour.mdc');

    const ruleContent = `---
description: Enforcement of Rigour quality gates and best practices.
globs: **/*
---

# Rigour Enforcement

You are operating under Rigour engineering discipline.

## Core Rules
- **Never claim done** until you run \`rigour check\` and it returns PASS.
- If checks FAIL, fix **only** the listed failures. Do not add new features or refactor unrelated code.
- Maintain project memory in \`docs/SPEC.md\`, \`docs/ARCH.md\`, and \`docs/DECISIONS.md\`.
- Keep files modular. If a file exceeds 500 lines, you MUST break it into smaller components.
- No \`TODO\` or \`FIXME\` comments allowed in the final submission.

## Workflow
1. Write/Modify code.
2. Run \`rigour check\`.
3. If FAIL: Read \`rigour-report.json\` for exact failure points and fix them.
4. If PASS: You may claim task completion.
`;

    await fs.writeFile(rulePath, ruleContent);
    console.log(chalk.green('✔ Initialized Agent Handshake (.cursor/rules/rigour.mdc)'));

    console.log(chalk.blue('\nRigour is ready. Run `rigour check` to verify your project.'));
}
