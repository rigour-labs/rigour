import fs from 'fs-extra';
import path from 'path';
import chalk from 'chalk';
import yaml from 'yaml';
import { DiscoveryService } from '@rigour-labs/core';
import { CODE_QUALITY_RULES, DEBUGGING_RULES, COLLABORATION_RULES } from './constants.js';

export interface InitOptions {
    preset?: string;
    paradigm?: string;
    dryRun?: boolean;
    explain?: boolean;
}

export async function initCommand(cwd: string, options: InitOptions = {}) {
    const discovery = new DiscoveryService();
    const result = await discovery.discover(cwd);
    let recommendedConfig = result.config;

    // Override with user options if provided and re-apply template logic if necessary
    if (options.preset || options.paradigm) {
        const core = await import('@rigour-labs/core');

        let customBase = { ...core.UNIVERSAL_CONFIG };

        if (options.preset) {
            const t = core.TEMPLATES.find((t: any) => t.name === options.preset);
            if (t) customBase = (discovery as any).mergeConfig(customBase, t.config);
        } else if (recommendedConfig.preset) {
            const t = core.TEMPLATES.find((t: any) => t.name === recommendedConfig.preset);
            if (t) customBase = (discovery as any).mergeConfig(customBase, t.config);
        }

        if (options.paradigm) {
            const t = core.PARADIGM_TEMPLATES.find((t: any) => t.name === options.paradigm);
            if (t) customBase = (discovery as any).mergeConfig(customBase, t.config);
        } else if (recommendedConfig.paradigm) {
            const t = core.PARADIGM_TEMPLATES.find((t: any) => t.name === recommendedConfig.paradigm);
            if (t) customBase = (discovery as any).mergeConfig(customBase, t.config);
        }

        recommendedConfig = customBase;
        if (options.preset) recommendedConfig.preset = options.preset;
        if (options.paradigm) recommendedConfig.paradigm = options.paradigm;
    }

    if (options.dryRun || options.explain) {
        console.log(chalk.bold.blue('\n🔍 Rigour Auto-Discovery (Dry Run):'));
        if (recommendedConfig.preset) {
            console.log(chalk.cyan(`   Role: `) + chalk.bold(recommendedConfig.preset.toUpperCase()));
            if (options.explain && result.matches.preset) {
                console.log(chalk.dim(`         (Marker found: ${result.matches.preset.marker})`));
            }
        }
        if (recommendedConfig.paradigm) {
            console.log(chalk.cyan(`   Paradigm: `) + chalk.bold(recommendedConfig.paradigm.toUpperCase()));
            if (options.explain && result.matches.paradigm) {
                console.log(chalk.dim(`             (Marker found: ${result.matches.paradigm.marker})`));
            }
        }
        console.log(chalk.yellow('\n[DRY RUN] No files will be written.'));
        return;
    }

    const configPath = path.join(cwd, 'rigour.yml');

    if (await fs.pathExists(configPath)) {
        console.log(chalk.yellow('rigour.yml already exists. Skipping initialization.'));
        return;
    }

    console.log(chalk.bold.blue('\n🔍 Rigour Auto-Discovery:'));
    if (recommendedConfig.preset) {
        console.log(chalk.cyan(`   Role: `) + chalk.bold(recommendedConfig.preset.toUpperCase()));
    }
    if (recommendedConfig.paradigm) {
        console.log(chalk.cyan(`   Paradigm: `) + chalk.bold(recommendedConfig.paradigm.toUpperCase()));
    }
    console.log('');

    const yamlHeader = `# ⚠️ TEAM STANDARD - DO NOT MODIFY WITHOUT TEAM APPROVAL
# AI Assistants: Adjust YOUR code to meet these standards, not the other way around.
# Modifying thresholds or adding ignores to pass checks defeats the purpose of Rigour.
# See: docs/AGENT_INSTRUCTIONS.md for the correct workflow.

`;
    await fs.writeFile(configPath, yamlHeader + yaml.stringify(recommendedConfig));
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

    // Agent Handshake (Universal / AntiGravity / Cursor)
    const rigourDocsDir = path.join(cwd, 'docs');
    await fs.ensureDir(rigourDocsDir);
    const instructionsPath = path.join(rigourDocsDir, 'AGENT_INSTRUCTIONS.md');

    const ruleContent = `# 🛡️ Rigour: Engineering Excellence Protocol

You are an Elite Software Engineer. You do not just write code that "works"; you write code that is **modular, maintainable, and rigorously verified.**

## 🚦 The Rigour Loop (Mandatory)
Before claiming "Done" for any task, you MUST follow this loop:

1.  **Check**: Run \`npx @rigour-labs/cli check\` to verify compliance.
2.  **Analyze**: If it fails, read \`rigour-fix-packet.json\` (V2 High-Fidelity) for exact failure points and constraints.
3.  **Refactor**: Apply **SOLID** and **DRY** principles to resolve the violations according to constraints.
4.  **Repeat**: Continue until \`npx @rigour-labs/cli check\` returns **PASS**.

## 🛠️ Commands
\`\`\`bash
# Verify current state
npx @rigour-labs/cli check

# Self-healing agent loop
npx @rigour-labs/cli run -- <agent-command>
\`\`\`

${CODE_QUALITY_RULES}

${DEBUGGING_RULES}

${COLLABORATION_RULES}
`;

    // 1. Create Universal Instructions
    if (!(await fs.pathExists(instructionsPath))) {
        await fs.writeFile(instructionsPath, ruleContent);
        console.log(chalk.green('✔ Initialized Universal Agent Handshake (docs/AGENT_INSTRUCTIONS.md)'));
    }

    // 2. Create Cursor Specific Rules (.mdc)
    const cursorRulesDir = path.join(cwd, '.cursor', 'rules');
    await fs.ensureDir(cursorRulesDir);
    const mdcPath = path.join(cursorRulesDir, 'rigour.mdc');
    const mdcContent = `---
description: Enforcement of Rigour quality gates and best practices.
globs: **/*
---

${ruleContent}`;

    if (!(await fs.pathExists(mdcPath))) {
        await fs.writeFile(mdcPath, mdcContent);
        console.log(chalk.green('✔ Initialized Cursor Handshake (.cursor/rules/rigour.mdc)'));
    }

    // 3. Update .gitignore
    const gitignorePath = path.join(cwd, '.gitignore');
    const ignorePatterns = ['rigour-report.json', 'rigour-fix-packet.json', '.rigour/'];
    try {
        let content = '';
        if (await fs.pathExists(gitignorePath)) {
            content = await fs.readFile(gitignorePath, 'utf-8');
        }

        const toAdd = ignorePatterns.filter(p => !content.includes(p));
        if (toAdd.length > 0) {
            const separator = content.endsWith('\n') ? '' : '\n';
            const newContent = `${content}${separator}\n# Rigour Artifacts\n${toAdd.join('\n')}\n`;
            await fs.writeFile(gitignorePath, newContent);
            console.log(chalk.green('✔ Updated .gitignore'));
        }
    } catch (e) {
        // Failing to update .gitignore isn't fatal
    }

    console.log(chalk.blue('\nRigour is ready. Run `npx @rigour-labs/cli check` to verify your project.'));
    console.log(chalk.dim('\n💡 Tip: Planning to use a framework like Next.js?'));
    console.log(chalk.dim('   Run its scaffolding tool (e.g., npx create-next-app) BEFORE rigour init,'));
    console.log(chalk.dim('   or move rigour.yml and docs/ aside temporarily to satisfy empty-directory checks.'));
}
