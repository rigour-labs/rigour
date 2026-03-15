import fs from 'fs-extra';
import path from 'path';
import chalk from 'chalk';
import yaml from 'yaml';
import { DiscoveryService, loadSettings, isModelCached, getModelsDir } from '@rigour-labs/core';
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

/**
 * Detect ALL IDEs/agents present in the project (not just the first match).
 * A project using Cursor often also has CLAUDE.md, .clinerules, etc.
 * We need hooks for every tool that has markers.
 */
function detectAllIDEs(cwd: string): DetectedIDE[] {
    const detected: DetectedIDE[] = [];

    if (fs.existsSync(path.join(cwd, 'CLAUDE.md')) || fs.existsSync(path.join(cwd, '.claude'))) {
        detected.push('claude');
    }
    if (fs.existsSync(path.join(cwd, '.cursor'))) {
        detected.push('cursor');
    }
    if (fs.existsSync(path.join(cwd, '.clinerules'))) {
        detected.push('cline');
    }
    if (fs.existsSync(path.join(cwd, '.windsurfrules')) || fs.existsSync(path.join(cwd, '.windsurf'))) {
        detected.push('windsurf');
    }
    if (fs.existsSync(path.join(cwd, '.gemini'))) {
        detected.push('gemini');
    }
    if (fs.existsSync(path.join(cwd, 'AGENTS.md'))) {
        detected.push('codex');
    }
    if (fs.existsSync(path.join(cwd, '.vscode'))) {
        detected.push('vscode');
    }

    // Fallback: check environment variables if no file markers found
    if (detected.length === 0) {
        const termProgram = process.env.TERM_PROGRAM || '';
        const terminal = process.env.TERMINAL_EMULATOR || '';
        const appName = process.env.APP_NAME || '';

        if (termProgram.toLowerCase().includes('cursor') || terminal.toLowerCase().includes('cursor')) {
            detected.push('cursor');
        } else if (termProgram.toLowerCase().includes('cline') || appName.toLowerCase().includes('cline')) {
            detected.push('cline');
        } else if (termProgram.toLowerCase().includes('vscode') || process.env.VSCODE_INJECTION) {
            detected.push('vscode');
        } else if (process.env.CLAUDE_CODE || process.env.ANTHROPIC_API_KEY) {
            detected.push('claude');
        } else if (process.env.GEMINI_API_KEY || process.env.GOOGLE_CLOUD_PROJECT) {
            detected.push('gemini');
        }
    }

    return detected.length > 0 ? detected : ['unknown'];
}

/** Legacy single-IDE detection for backward compatibility (returns primary IDE). */
function detectIDE(cwd: string): DetectedIDE {
    const all = detectAllIDEs(cwd);
    return all[0] || 'unknown';
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

    // Always enable hooks for ALL supported tools.
    // Detection is unreliable (Cursor doesn't create .cursor/ by default,
    // its terminal reports as vscode). The config files are tiny and harmless
    // if the tool isn't used, but critical if it is.
    type HookToolName = 'claude' | 'cursor' | 'cline' | 'windsurf';
    const ALL_HOOK_TOOLS: HookToolName[] = ['claude', 'cursor', 'cline', 'windsurf'];
    recommendedConfig.hooks = {
        ...recommendedConfig.hooks,
        enabled: true,
        tools: ALL_HOOK_TOOLS,
    };

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

    const ruleContent = `# Rigour: Engineering Governance

This project uses **Rigour MCP tools** for automated quality governance. The tools are self-describing — read their descriptions to discover the correct workflow automatically.

## Key Rules

- **Never** modify \`rigour.yml\` thresholds or ignore lists to make checks pass — fix the code instead.
- **Never** claim "done" without a passing quality gate result.
- Real-time hooks run automatically after every file edit. If a hook blocks you, fix the issue before continuing.
- All actions are logged to the project's audit trail, visible in **Rigour Studio**.

${AGNOSTIC_AI_INSTRUCTIONS}
${CODE_QUALITY_RULES}
${DEBUGGING_RULES}
${COLLABORATION_RULES}
`;

    // 1. Create Universal Instructions
    if (!(await fs.pathExists(instructionsPath)) || options.force) {
        await fs.writeFile(instructionsPath, ruleContent);
        console.log(chalk.green('✔ Initialized Universal Agent Handshake (docs/AGENT_INSTRUCTIONS.md)'));
    }

    // 2. Create IDE-Specific Rules for ALL supported tools.
    //    Detection is unreliable (Cursor reports as vscode, doesn't create .cursor/),
    //    so we always set up everything. The files are tiny and inert if unused.
    const shouldSetup = (_ide: DetectedIDE) => true;

    if (shouldSetup('cursor')) {
        const cursorRulesDir = path.join(cwd, '.cursor', 'rules');
        await fs.ensureDir(cursorRulesDir);
        const mdcPath = path.join(cursorRulesDir, 'rigour.mdc');
        // Cursor .mdc must be SHORT and forceful — long rules get ignored.
        // Keep ONLY the mandatory MCP tool workflow, no generic coding advice.
        const mdcContent = `---
description: Rigour governance — use Rigour MCP tools for quality gates.
globs: **/*
alwaysApply: true
---

# Rigour Governance

This project uses **Rigour MCP tools** for automated quality governance. The tools are self-describing — read their descriptions to discover the correct workflow automatically.

Hooks run automatically after every file edit. If a hook blocks you, fix the issue before continuing.

## Rules
- Never modify rigour.yml to make checks pass — fix the code instead.
- Never claim "done" without a passing quality gate result.
`;

        if (!(await fs.pathExists(mdcPath)) || options.force) {
            await fs.writeFile(mdcPath, mdcContent);
            console.log(chalk.green('✔ Initialized Cursor Handshake (.cursor/rules/rigour.mdc)'));
        }
    }

    if (shouldSetup('vscode')) {
        // VS Code users use the universal AGENT_INSTRUCTIONS.md (already created above)
        // We could also add .vscode/settings.json or snippets here if needed
        console.log(chalk.green('✔ VS Code mode - using Universal Handshake (docs/AGENT_INSTRUCTIONS.md)'));
    }

    if (shouldSetup('cline')) {
        const clineRulesPath = path.join(cwd, '.clinerules');
        if (!(await fs.pathExists(clineRulesPath)) || options.force) {
            await fs.writeFile(clineRulesPath, ruleContent);
            console.log(chalk.green('✔ Initialized Cline Handshake (.clinerules)'));
        }
    }

    // Claude Code (CLAUDE.md)
    if (shouldSetup('claude')) {
        const claudePath = path.join(cwd, 'CLAUDE.md');
        const claudeContent = `# CLAUDE.md - Project Instructions for Claude Code

This project uses Rigour for quality gates. Rigour MCP tools are available — they are self-describing.

## CLI Commands (alternative to MCP tools)

\`\`\`bash
npx @rigour-labs/cli check      # Run quality gates
npx @rigour-labs/cli explain    # Explain failures
npx @rigour-labs/cli run -- claude "<task>"  # Self-healing agent loop
\`\`\`

${ruleContent}`;

        if (!(await fs.pathExists(claudePath)) || options.force) {
            await fs.writeFile(claudePath, claudeContent);
            console.log(chalk.green('✔ Initialized Claude Code Handshake (CLAUDE.md)'));
        }
    }

    // Gemini Code Assist (.gemini/styleguide.md)
    if (shouldSetup('gemini')) {
        const geminiDir = path.join(cwd, '.gemini');
        await fs.ensureDir(geminiDir);
        const geminiStylePath = path.join(geminiDir, 'styleguide.md');
        const geminiContent = `# Gemini Code Assist Style Guide

This project uses Rigour for quality gates. If Rigour MCP tools are available, they are self-describing — use them.

${ruleContent}`;

        if (!(await fs.pathExists(geminiStylePath)) || options.force) {
            await fs.writeFile(geminiStylePath, geminiContent);
            console.log(chalk.green('✔ Initialized Gemini Handshake (.gemini/styleguide.md)'));
        }
    }

    // OpenAI Codex / Aider (AGENTS.md - Universal Standard)
    if (shouldSetup('codex')) {
        const agentsPath = path.join(cwd, 'AGENTS.md');
        const agentsContent = `# AGENTS.md - AI Agent Instructions

This project uses Rigour for quality gates. If Rigour MCP tools are available, they are self-describing — use them. Otherwise use the CLI:

\`\`\`bash
npx @rigour-labs/cli check   # Run quality gates (must PASS before task is done)
npx @rigour-labs/cli explain # Explain failures
\`\`\`

${ruleContent}`;

        if (!(await fs.pathExists(agentsPath)) || options.force) {
            await fs.writeFile(agentsPath, agentsContent);
            console.log(chalk.green('✔ Initialized Universal Agent Handshake (AGENTS.md)'));
        }
    }

    // Windsurf (.windsurfrules)
    if (shouldSetup('windsurf')) {
        const windsurfPath = path.join(cwd, '.windsurfrules');
        if (!(await fs.pathExists(windsurfPath)) || options.force) {
            await fs.writeFile(windsurfPath, ruleContent);
            console.log(chalk.green('✔ Initialized Windsurf Handshake (.windsurfrules)'));
        }
    }

    // 3. Auto-initialize hooks for ALL supported AI coding tools
    const allSupportedIDEs: DetectedIDE[] = ['claude', 'cursor', 'cline', 'windsurf'];
    await initHooksForAllDetectedTools(cwd, allSupportedIDEs);

    // 4. Auto-register MCP server for all supported tools
    await initMCPForDetectedTools(cwd, allSupportedIDEs, options.force);

    // 5. Update .gitignore
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

    // 6. Auto-build pattern index (with semantic embeddings)
    await buildPatternIndex(cwd, options.force);

    console.log(chalk.blue('\nRigour is ready. Run `npx @rigour-labs/cli check` to verify your project.'));

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

    // 5. Auto-prerequisites check
    await checkPrerequisites();
}

/**
 * Auto-prerequisites check — runs after init to guide deep analysis setup.
 * Checks settings.json for API keys, local model availability, and prints
 * actionable next steps.
 */
async function checkPrerequisites(): Promise<void> {
    console.log(chalk.bold.cyan('\n🔧 Deep Analysis Prerequisites:'));

    const settings = loadSettings();
    const providers = settings.providers || {};
    const configuredKeys = Object.entries(providers).filter(([_, key]) => !!key);

    // Check 1: API keys in settings.json
    const hasApiKey = configuredKeys.length > 0;
    if (hasApiKey) {
        const providerNames = configuredKeys.map(([name]) => name).join(', ');
        console.log(chalk.green(`  ✔ API keys configured: ${providerNames}`));
    } else {
        console.log(chalk.yellow('  ○ No API keys configured'));
    }

    // Check 2: Local model availability
    const hasLiteModel = await isModelCached('lite');
    const hasDeepModel = await isModelCached('deep');
    if (hasLiteModel || hasDeepModel) {
        const models = [];
        if (hasLiteModel) models.push('lite (500MB)');
        if (hasDeepModel) models.push('deep (900MB)');
        console.log(chalk.green(`  ✔ Local models cached: ${models.join(', ')}`));
    } else {
        console.log(chalk.yellow('  ○ No local models cached'));
    }

    // Check 3: Sidecar binary
    let hasSidecar = false;
    try {
        const { execSync } = await import('child_process');
        const result = execSync('which llama-cli 2>/dev/null || which rigour-brain 2>/dev/null', { encoding: 'utf-8', timeout: 3000 }).trim();
        hasSidecar = result.length > 0;
    } catch {
        // Also check ~/.rigour/bin/
        const binDir = path.join(getModelsDir(), '..', 'bin');
        hasSidecar = fs.existsSync(path.join(binDir, 'rigour-brain')) || fs.existsSync(path.join(binDir, 'llama-cli'));
    }

    if (hasSidecar) {
        console.log(chalk.green('  ✔ Inference binary available'));
    } else if (!hasApiKey) {
        console.log(chalk.yellow('  ○ No local inference binary found'));
    }

    // Summary: what can the user do?
    const isReady = hasApiKey || (hasSidecar && (hasDeepModel || hasLiteModel));

    if (isReady) {
        console.log(chalk.green('\n  ✓ Deep analysis is ready!'));
        if (hasSidecar && hasDeepModel) {
            console.log(chalk.dim('    Run: rigour check --deep              (Rigour local engine)'));
            console.log(chalk.dim('    Run: rigour check --deep --pro        (full model, code-specialized)'));
        } else if (hasSidecar && hasLiteModel) {
            console.log(chalk.dim('    Run: rigour check --deep              (Rigour local engine — lite)'));
        }
        if (hasApiKey) {
            const defaultProvider = settings.deep?.defaultProvider || configuredKeys[0]?.[0] || 'unknown';
            console.log(chalk.dim(`    Run: rigour check --deep --provider ${defaultProvider}  (cloud BYOK)`));
        }
    } else {
        console.log(chalk.bold.yellow('\n  ⚡ Set up deep analysis (optional):'));
        console.log('');
        console.log(chalk.bold('  Option A: Rigour Local Engine (Recommended — private, no API key needed)'));
        console.log(chalk.dim('    rigour check --deep                              # Lite model (500MB, any CPU)'));
        console.log(chalk.dim('    rigour check --deep --pro                        # Full model (900MB, code-specialized)'));
        console.log(chalk.dim('    Fine-tuned on real code quality findings via RLAIF pipeline.'));
        console.log(chalk.dim('    100% local — your code never leaves your machine.'));
        console.log('');
        console.log(chalk.bold('  Option B: Cloud BYOK (bring your own API key)'));
        console.log(chalk.dim('    rigour settings set-key anthropic sk-ant-xxx     # Claude'));
        console.log(chalk.dim('    rigour settings set-key openai sk-xxx            # OpenAI'));
        console.log(chalk.dim('    rigour settings set-key groq gsk_xxx            # Groq'));
        console.log(chalk.dim('    Then: rigour check --deep --provider <name>'));
        console.log('');
        console.log(chalk.dim('  Without deep analysis, Rigour still runs 27+ deterministic quality gates.'));
    }
    console.log('');
}

// Maps detected IDE to hook tool name
const IDE_TO_HOOK_TOOL: Record<string, string> = {
    claude: 'claude',
    cursor: 'cursor',
    cline: 'cline',
    windsurf: 'windsurf',
};

/**
 * Build the pattern index so rigour_check_pattern can detect duplicates.
 * Uses semantic embeddings by default for fuzzy matching.
 * Non-fatal — if indexing fails, init still succeeds.
 */
async function buildPatternIndex(cwd: string, force?: boolean): Promise<void> {
    try {
        console.log(chalk.dim('\n   Building pattern index (this enables duplicate detection)...'));
        const {
            PatternIndexer,
            savePatternIndex,
            loadPatternIndex,
            getDefaultIndexPath
        } = await import('@rigour-labs/core/pattern-index');

        const indexPath = getDefaultIndexPath(cwd);
        const existingIndex = await loadPatternIndex(indexPath);

        const indexer = new PatternIndexer(cwd, { useEmbeddings: false });

        let index;
        if (existingIndex && !force) {
            index = await indexer.updateIndex(existingIndex);
        } else {
            index = await indexer.buildIndex();
        }

        await savePatternIndex(index, indexPath);
        console.log(chalk.green(`✔ Pattern index built: ${index.stats.totalPatterns} patterns across ${index.stats.totalFiles} files`));
    } catch (err: any) {
        console.log(chalk.dim(`   (Pattern index build skipped: ${err?.message || err})`));
    }
}

/**
 * Initialize hooks for ALL detected IDEs/agents.
 * Returns the list of hook tool names that were successfully initialized.
 */
async function initHooksForAllDetectedTools(
    cwd: string,
    detectedIDEs: DetectedIDE[]
): Promise<string[]> {
    const enabledTools: string[] = [];

    for (const ide of detectedIDEs) {
        const hookTool = IDE_TO_HOOK_TOOL[ide];
        if (!hookTool) continue; // No hook support (vscode, gemini, codex)

        try {
            console.log(chalk.dim(`\n   Setting up real-time hooks for ${ide}...`));
            await hooksInitCommand(cwd, { tool: hookTool, dlp: true, force: true, block: true });
            enabledTools.push(hookTool);
        } catch (err: any) {
            console.log(chalk.dim(`   (Hooks setup for ${ide} failed: ${err?.message || err})`));
        }
    }

    if (enabledTools.length > 0) {
        console.log(chalk.dim(`   🛑 DLP protection active for: ${enabledTools.join(', ')}`));
    }

    return enabledTools;
}

/**
 * Auto-register the Rigour MCP server for detected AI coding tools.
 *
 * Cursor: .cursor/mcp.json  → { mcpServers: { rigour: { command, args } } }
 * Claude: .claude/settings.json → merge mcpServers into existing settings
 */
/**
 * Resolve the MCP server config. If the CLI is running from a local dev
 * checkout (not npx/global), point MCP at the sibling rigour-mcp dist
 * so it works without publishing. Otherwise use npx.
 */
function resolveMCPServerConfig(): { command: string; args: string[] } {
    // ESM has no __dirname — derive from import.meta.url
    const thisDir = path.dirname(new URL(import.meta.url).pathname);
    // thisDir is packages/rigour-cli/dist/commands/
    // Sibling MCP package is at packages/rigour-mcp/dist/index.js
    const localMcpEntry = path.resolve(thisDir, '../../../rigour-mcp/dist/index.js');
    if (fs.existsSync(localMcpEntry)) {
        // Running from local dev checkout — use local path
        return { command: 'node', args: [localMcpEntry] };
    }
    // Fallback: published npm package
    return { command: 'npx', args: ['-y', '@rigour-labs/mcp'] };
}

async function initMCPForDetectedTools(
    cwd: string,
    detectedIDEs: DetectedIDE[],
    force?: boolean,
): Promise<void> {
    const mcpServerConfig = resolveMCPServerConfig();

    for (const ide of detectedIDEs) {
        try {
            if (ide === 'cursor') {
                await setupCursorMCP(cwd, mcpServerConfig, force);
            } else if (ide === 'claude') {
                await setupClaudeMCP(cwd, mcpServerConfig, force);
            }
            // Other IDEs: MCP not yet supported or handled differently
        } catch {
            // Non-fatal
        }
    }
}

async function setupCursorMCP(
    cwd: string,
    serverConfig: { command: string; args: string[] },
    force?: boolean,
): Promise<void> {
    const mcpPath = path.join(cwd, '.cursor', 'mcp.json');
    await fs.ensureDir(path.dirname(mcpPath));

    let existing: any = {};
    if (await fs.pathExists(mcpPath)) {
        try {
            existing = await fs.readJson(mcpPath);
        } catch {
            existing = {};
        }
        // Don't overwrite if rigour already registered (unless --force)
        if (existing?.mcpServers?.rigour && !force) {
            return;
        }
    }

    if (!existing.mcpServers) existing.mcpServers = {};
    existing.mcpServers.rigour = serverConfig;

    await fs.writeJson(mcpPath, existing, { spaces: 4 });
    console.log(chalk.green('✔ Registered Rigour MCP server (.cursor/mcp.json)'));
}

async function setupClaudeMCP(
    cwd: string,
    serverConfig: { command: string; args: string[] },
    force?: boolean,
): Promise<void> {
    const settingsPath = path.join(cwd, '.claude', 'settings.json');
    await fs.ensureDir(path.dirname(settingsPath));

    // Always read existing settings (hooks may have written this file already)
    let existing: any = {};
    if (await fs.pathExists(settingsPath)) {
        try {
            existing = await fs.readJson(settingsPath);
        } catch {
            existing = {};
        }
        if (existing?.mcpServers?.rigour && !force) {
            return;
        }
    }

    // Merge — preserve existing hooks config, just add/update mcpServers.rigour
    if (!existing.mcpServers) existing.mcpServers = {};
    existing.mcpServers.rigour = serverConfig;

    await fs.writeJson(settingsPath, existing, { spaces: 4 });
    console.log(chalk.green('✔ Registered Rigour MCP server (.claude/settings.json)'));
}
