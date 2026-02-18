import fs from 'fs-extra';
import path from 'path';
import chalk from 'chalk';
import yaml from 'yaml';
import { DiscoveryService } from '@rigour-labs/core';
import { CODE_QUALITY_RULES, DEBUGGING_RULES, COLLABORATION_RULES, AGNOSTIC_AI_INSTRUCTIONS } from './constants.js';
import { hooksInitCommand } from './hooks.js';
import { randomUUID } from 'crypto';

// Helper to log events for Rigour Studio
async function logStudioEvent(cwd: string, event: any) {
    try {
        const rigourDir = path.join(cwd, ".rigour");
        await fs.ensureDir(rigourDir);
        const eventsPath = path.join(rigourDir, "events.jsonl");
        const logEntry = JSON.stringify({
            id: randomUUID(),
            timestamp: new Date().toISOString(),
            ...event
        }) + "\n";
        await fs.appendFile(eventsPath, logEntry);
    } catch {
        // Silent fail
    }
}

export interface InitOptions {
    preset?: string;
    paradigm?: string;
    ide?: 'cursor' | 'vscode' | 'cline' | 'claude' | 'gemini' | 'codex' | 'windsurf' | 'all';
    dryRun?: boolean;
    explain?: boolean;
    force?: boolean;
}

type DetectedIDE = 'cursor' | 'vscode' | 'cline' | 'claude' | 'gemini' | 'codex' | 'windsurf' | 'unknown';

function detectIDE(cwd: string): DetectedIDE {
    // Check for Claude Code markers
    if (fs.existsSync(path.join(cwd, 'CLAUDE.md')) || fs.existsSync(path.join(cwd, '.claude'))) {
        return 'claude';
    }

    // Check for Gemini Code Assist markers
    if (fs.existsSync(path.join(cwd, '.gemini'))) {
        return 'gemini';
    }

    // Check for Codex/Aider AGENTS.md (universal standard)
    if (fs.existsSync(path.join(cwd, 'AGENTS.md'))) {
        return 'codex';
    }

    // Check for Windsurf markers
    if (fs.existsSync(path.join(cwd, '.windsurfrules')) || fs.existsSync(path.join(cwd, '.windsurf'))) {
        return 'windsurf';
    }

    // Check for Cline-specific markers
    if (fs.existsSync(path.join(cwd, '.clinerules'))) {
        return 'cline';
    }

    // Check for Cursor-specific markers
    if (fs.existsSync(path.join(cwd, '.cursor'))) {
        return 'cursor';
    }

    // Check for VS Code markers
    if (fs.existsSync(path.join(cwd, '.vscode'))) {
        return 'vscode';
    }

    // Check environment variables that IDEs/Agents set
    const termProgram = process.env.TERM_PROGRAM || '';
    const terminal = process.env.TERMINAL_EMULATOR || '';
    const appName = process.env.APP_NAME || '';

    if (termProgram.toLowerCase().includes('cursor') || terminal.toLowerCase().includes('cursor')) {
        return 'cursor';
    }

    if (termProgram.toLowerCase().includes('cline') || appName.toLowerCase().includes('cline')) {
        return 'cline';
    }

    if (termProgram.toLowerCase().includes('vscode') || process.env.VSCODE_INJECTION) {
        return 'vscode';
    }

    // Check for Claude Code environment
    if (process.env.CLAUDE_CODE || process.env.ANTHROPIC_API_KEY) {
        return 'claude';
    }

    // Check for Gemini environment
    if (process.env.GEMINI_API_KEY || process.env.GOOGLE_CLOUD_PROJECT) {
        return 'gemini';
    }

    return 'unknown';
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
        if (!options.force) {
            console.log(chalk.yellow('rigour.yml already exists.'));
            console.log(chalk.dim('  → Run with --force to regenerate with latest templates'));
            console.log(chalk.dim('  → Your current config will be backed up to rigour.yml.bak'));
            return;
        }
        // Backup existing config
        const backupPath = path.join(cwd, 'rigour.yml.bak');
        await fs.copy(configPath, backupPath);
        console.log(chalk.dim(`  Backed up existing config to rigour.yml.bak`));
    }

    console.log(chalk.bold.blue('\n🔍 Rigour Auto-Discovery:'));

    const requestId = randomUUID();
    await logStudioEvent(cwd, {
        type: "tool_call",
        requestId,
        tool: "rigour_init",
        arguments: options
    });
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
            await fs.ensureDir(path.dirname(filePath)); // Ensure parent directory exists
            await fs.ensureFile(filePath);
            console.log(chalk.dim(`  - Created ${file}`));
        }
    }

    // Agent Handshake (Universal / AntiGravity / Cursor)
    const rigourDocsDir = path.join(cwd, 'docs');
    await fs.ensureDir(rigourDocsDir);
    const instructionsPath = path.join(rigourDocsDir, 'AGENT_INSTRUCTIONS.md');

    const ruleContent = `# 🛡️ Rigour: Mandatory Engineering Governance Protocol

**You are an AI Engineering Agent governed by Rigour.** 

Your access to this codebase is conditional upon your strict adherence to the **Rigour Governance Protocol**. This is an automated requirement for every engineering task.

## 🚦 The Mandatory Governance Loop
You MUST execute this loop for every task. No code changes will be accepted as "Done" until they pass all Rigour quality gates.

1.  **Context Loading**: Call \`rigour_recall\` (MCP) to align with project-specific engineering memory.
2.  **Verify Patterns**: Before implementing new logic, call \`rigour_check_pattern\` to prevent reinvention and ensure security compliance.
3.  **Audit Enforcement**: Before finishing, you MUST call \`npx @rigour-labs/cli check\`.
4.  **Failure Remediation**: If the check returns **FAIL**, you MUST implement all required engineering refinements.
5.  **PASS or REJECT**: You may only declare a task complete when the check returns **PASS**.

## ⚖️ Transparency & Accountability
**Every action, tool call, and logic shift you perform is automatically logged to the project's local audit trail.** This data is visible in real-time in the human-monitored **Rigour Studio**.

${AGNOSTIC_AI_INSTRUCTIONS}
${CODE_QUALITY_RULES}
${DEBUGGING_RULES}
${COLLABORATION_RULES}
`;

    // 1. Create Universal Instructions
    if (!(await fs.pathExists(instructionsPath))) {
        await fs.writeFile(instructionsPath, ruleContent);
        console.log(chalk.green('✔ Initialized Universal Agent Handshake (docs/AGENT_INSTRUCTIONS.md)'));
    }

    // 2. Create IDE-Specific Rules based on detection or user preference
    const detectedIDE = detectIDE(cwd);
    const targetIDE = options.ide || (detectedIDE !== 'unknown' ? detectedIDE : 'all');

    if (detectedIDE !== 'unknown' && !options.ide) {
        console.log(chalk.dim(`   (Auto-detected IDE: ${detectedIDE})`));
    }

    if (targetIDE === 'cursor' || targetIDE === 'all') {
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
    }

    if (targetIDE === 'vscode' || targetIDE === 'all') {
        // VS Code users use the universal AGENT_INSTRUCTIONS.md (already created above)
        // We could also add .vscode/settings.json or snippets here if needed
        console.log(chalk.green('✔ VS Code mode - using Universal Handshake (docs/AGENT_INSTRUCTIONS.md)'));
    }

    if (targetIDE === 'cline' || targetIDE === 'all') {
        const clineRulesPath = path.join(cwd, '.clinerules');
        if (!(await fs.pathExists(clineRulesPath))) {
            await fs.writeFile(clineRulesPath, ruleContent);
            console.log(chalk.green('✔ Initialized Cline Handshake (.clinerules)'));
        }
    }

    // Claude Code (CLAUDE.md)
    if (targetIDE === 'claude' || targetIDE === 'all') {
        const claudePath = path.join(cwd, 'CLAUDE.md');
        const claudeContent = `# CLAUDE.md - Project Instructions for Claude Code

This file provides Claude Code with context about this project.

## Project Overview

This project uses Rigour for quality gates. Always run \`npx @rigour-labs/cli check\` before marking tasks complete.

## Commands

\`\`\`bash
# Verify quality gates
npx @rigour-labs/cli check

# Get fix packet for failures
npx @rigour-labs/cli explain

# Self-healing agent loop
npx @rigour-labs/cli run -- claude "<task>"
\`\`\`

${ruleContent}`;

        if (!(await fs.pathExists(claudePath))) {
            await fs.writeFile(claudePath, claudeContent);
            console.log(chalk.green('✔ Initialized Claude Code Handshake (CLAUDE.md)'));
        }
    }

    // Gemini Code Assist (.gemini/styleguide.md)
    if (targetIDE === 'gemini' || targetIDE === 'all') {
        const geminiDir = path.join(cwd, '.gemini');
        await fs.ensureDir(geminiDir);
        const geminiStylePath = path.join(geminiDir, 'styleguide.md');
        const geminiContent = `# Gemini Code Assist Style Guide

This project uses Rigour for quality gates.

## Required Before Completion

Always run \`npx @rigour-labs/cli check\` before marking any task complete.

${ruleContent}`;

        if (!(await fs.pathExists(geminiStylePath))) {
            await fs.writeFile(geminiStylePath, geminiContent);
            console.log(chalk.green('✔ Initialized Gemini Handshake (.gemini/styleguide.md)'));
        }
    }

    // OpenAI Codex / Aider (AGENTS.md - Universal Standard)
    if (targetIDE === 'codex' || targetIDE === 'all') {
        const agentsPath = path.join(cwd, 'AGENTS.md');
        const agentsContent = `# AGENTS.md - Universal AI Agent Instructions

This file provides instructions for AI coding agents (Codex, Aider, and others).

## Setup

\`\`\`bash
npm install
npm run dev
npm test
\`\`\`

## Quality Gates

This project uses Rigour. Before completing any task:

\`\`\`bash
npx @rigour-labs/cli check
\`\`\`

${ruleContent}`;

        if (!(await fs.pathExists(agentsPath))) {
            await fs.writeFile(agentsPath, agentsContent);
            console.log(chalk.green('✔ Initialized Universal Agent Handshake (AGENTS.md)'));
        }
    }

    // Windsurf (.windsurfrules)
    if (targetIDE === 'windsurf' || targetIDE === 'all') {
        const windsurfPath = path.join(cwd, '.windsurfrules');
        if (!(await fs.pathExists(windsurfPath))) {
            await fs.writeFile(windsurfPath, ruleContent);
            console.log(chalk.green('✔ Initialized Windsurf Handshake (.windsurfrules)'));
        }
    }

    // 3. Auto-initialize hooks for detected AI coding tools
    await initHooksForDetectedTools(cwd, detectedIDE);

    // 4. Update .gitignore
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
    console.log(chalk.cyan('Next Step: ') + chalk.bold('rigour index') + chalk.dim(' (Populate the Pattern Index)'));

    // Bootstrap initial memory for the Studio
    const rigourDir = path.join(cwd, ".rigour");
    await fs.ensureDir(rigourDir);
    const memPath = path.join(rigourDir, "memory.json");
    if (!(await fs.pathExists(memPath))) {
        await fs.writeJson(memPath, {
            memories: {
                "project_boot": {
                    value: `Governance initiated via '${options.preset || 'api'}' preset. This project is now monitored by Rigour Studio.`,
                    timestamp: new Date().toISOString()
                }
            }
        }, { spaces: 2 });
    }

    console.log(chalk.dim('\n💡 Tip: Planning to use a framework like Next.js?'));
    console.log(chalk.dim('   Run its scaffolding tool (e.g., npx create-next-app) BEFORE rigour init,'));
    console.log(chalk.dim('   or move rigour.yml and docs/ aside temporarily to satisfy empty-directory checks.'));

    await logStudioEvent(cwd, {
        type: "tool_response",
        requestId,
        tool: "rigour_init",
        status: "success",
        content: [{ type: "text", text: `Rigour Governance Initialized` }]
    });
}

// Maps detected IDE to hook tool name
const IDE_TO_HOOK_TOOL: Record<string, string> = {
    claude: 'claude',
    cursor: 'cursor',
    cline: 'cline',
    windsurf: 'windsurf',
};

async function initHooksForDetectedTools(
    cwd: string,
    detectedIDE: DetectedIDE
): Promise<void> {
    const hookTool = IDE_TO_HOOK_TOOL[detectedIDE];
    if (!hookTool) {
        return; // Unknown IDE or no hook support (vscode, gemini, codex)
    }

    try {
        console.log(chalk.dim(`\n   Setting up real-time hooks for ${detectedIDE}...`));
        await hooksInitCommand(cwd, { tool: hookTool });
    } catch {
        // Non-fatal — hooks are a bonus, not a requirement
        console.log(chalk.dim(`   (Hooks setup skipped — run 'rigour hooks init' manually)`));
    }
}
