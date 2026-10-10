import fs from 'fs-extra';
import path from 'path';
import chalk from 'chalk';
import yaml from 'yaml';
import { DiscoveryService, loadSettings } from '@rigour-labs/core';
import { hooksInitCommand } from './hooks.js';
import { randomUUID } from 'crypto';
import { writeAgentInstructions } from './init-handshake.js';
import { recordCreated } from './install-record.js';
import { askTelemetryOnce } from './telemetry-consent.js';
import { getCliVersion } from '../utils/cli-version.js';

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

/** What setup adds to .gitignore: Rigour's state stays local except what a team shares (dismissals, the functions reviewed before the PR, the backtest ledger). Uninstall removes exactly these. */
export const GITIGNORE_PATTERNS = ['rigour-report.json', 'rigour-fix-packet.json', '.rigour/*', '!.rigour/dismissed.json', '!.rigour/dismissed-review-items.json', '!.rigour/reviewed.json', '!.rigour/backtest.json'];

export interface InitOptions {
    preset?: string;
    paradigm?: string;
    /** The agents to set up (claude, cursor, cline, windsurf, all; comma-separated). Default: the ones the repository shows signs of. */
    ide?: string;
    dryRun?: boolean;
    explain?: boolean;
    force?: boolean;
    /** Write AGENTS.md (and a CLAUDE.md importing it) where the project has none. Off by default: the MCP tools describe themselves and the hooks enforce. */
    instructions?: boolean;
    /** Also install the team's briefing hooks (rigour setup turns it on; plain init leaves it to hooks init --brief). */
    brief?: boolean;
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

const HOOK_AGENTS: DetectedIDE[] = ['claude', 'cursor', 'cline', 'windsurf'];

/** The agents to give hooks and the MCP server: the ones asked for, else the ones this repository shows signs of, else Claude Code. */
function agentsToSetUp(cwd: string, asked?: string): DetectedIDE[] {
    if (asked) {
        const names = asked.split(',').map(name => name.trim());
        return names.includes('all') ? HOOK_AGENTS : HOOK_AGENTS.filter(agent => names.includes(agent));
    }
    const found = detectAllIDEs(cwd).filter(ide => HOOK_AGENTS.includes(ide));
    return found.length ? found : ['claude'];
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

    // Rigour does not create empty documents to satisfy a gate; a team that wants required docs lists them.
    recommendedConfig.gates.required_files = [];

    const yamlHeader = `# ⚠️ TEAM STANDARD - DO NOT MODIFY WITHOUT TEAM APPROVAL
# AI Assistants: Adjust YOUR code to meet these standards, not the other way around.
# Modifying thresholds or adding ignores to pass checks defeats the purpose of Rigour.
# What blocks and how to answer a finding: https://github.com/rigour-labs/rigour/blob/main/docs/DEVELOPMENT.md

`;
    await fs.writeFile(configPath, yamlHeader + yaml.stringify(recommendedConfig));
    console.log(chalk.green('✔ Created rigour.yml'));

    if (options.instructions) await writeAgentInstructions(cwd, options.force);

    // 3. Hooks and the MCP server for the agents this repository uses, and no others.
    const agents = agentsToSetUp(cwd, options.ide);
    await initHooksForAllDetectedTools(cwd, agents, !!options.brief);
    await initMCPForDetectedTools(cwd, agents, options.force);
    const others = HOOK_AGENTS.filter(agent => !agents.includes(agent));
    if (others.length) console.log(chalk.dim(`   Set up for ${agents.join(', ')}. Another agent later: rigour hooks init --tool ${others.join('|')}`));

    // 5. Update .gitignore: Rigour's state stays out of git, except what the team shares (the
    //    dismissals and the backtest ledger). A whole-directory `.rigour/` would hide those too,
    //    since git cannot re-include a file under an excluded directory, so it becomes `.rigour/*`.
    const gitignorePath = path.join(cwd, '.gitignore');
    const ignorePatterns = GITIGNORE_PATTERNS;
    try {
        let content = '';
        if (await fs.pathExists(gitignorePath)) {
            content = (await fs.readFile(gitignorePath, 'utf-8')).replace(/^\.rigour\/$/m, '.rigour/*');
        }

        const lines = content.split('\n').map(l => l.trim());
        const toAdd = ignorePatterns.filter(p => !lines.includes(p));
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

    console.log(chalk.blue('\nRigour is ready. Run `rigour review` to check your work.'));

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

    // 6. The one-time telemetry question (a person at a terminal only; never in CI)
    await askTelemetryOnce();
}

/**
 * Who reviews the riskiest changed code. With an agent nothing is needed: it answers Rigour's
 * questions with its own model. A key is for code written without an agent, and for PR reviews.
 */
async function checkPrerequisites(): Promise<void> {
    const providers = loadSettings().providers || {};
    const configured = Object.entries(providers).filter(([, key]) => !!key).map(([name]) => name);
    console.log(chalk.bold.cyan('\nModel review of risky code'));
    console.log(chalk.dim('  With an agent: nothing to set up. It answers Rigour\'s questions with its own model.'));
    if (configured.length) {
        console.log(chalk.green(`  ✔ Your key for code written without an agent and for PR reviews: ${configured.join(', ')}`));
    } else {
        console.log(chalk.dim('  Without an agent, or for PR reviews: rigour settings set-key anthropic <key>   (or openai, openrouter)'));
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

const PRIMARY_HOOK_PATH: Record<string, string> = {
    claude: '.claude/settings.json',
    cursor: '.cursor/hooks.json',
    cline: '.clinerules/hooks/PostToolUse',
    windsurf: '.windsurf/hooks.json',
};

/**
 * Build the pattern index so rigour_check_pattern can detect duplicates.
 * Structural only here, so init stays fast; automatic indexing embeds the patterns in the
 * background on first use (an explicit `rigour index --no-semantic` opts out).
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
    detectedIDEs: DetectedIDE[],
    brief: boolean
): Promise<string[]> {
    // No hook support for vscode, gemini, codex. One run for every agent: one summary, one DLP note, one git hook line.
    const hookTools = detectedIDEs.map(ide => IDE_TO_HOOK_TOOL[ide]).filter((tool): tool is string => !!tool);
    if (hookTools.length === 0) return [];
    try {
        console.log(chalk.dim(`\n   Setting up real-time hooks for ${hookTools.join(', ')}...`));
        await hooksInitCommand(cwd, { tool: hookTools.join(','), dlp: true, force: true, block: true, brief });
    } catch (err: any) {
        console.log(chalk.dim(`   (Hooks setup failed: ${err?.message || err})`));
    }
    const enabledTools: string[] = [];
    for (const tool of hookTools) {
        if (await fs.pathExists(path.join(cwd, PRIMARY_HOOK_PATH[tool]))) enabledTools.push(tool);
    }
    return enabledTools;
}

/**
 * Resolve the MCP server config. If the CLI is running from a local dev
 * checkout (not npx/global), point MCP at the sibling rigour-mcp dist
 * so it works without publishing. Otherwise use npx.
 */
export function resolveMCPServerConfig(): { command: string; args: string[] } {
    // ESM has no __dirname — derive from import.meta.url
    const thisDir = path.dirname(new URL(import.meta.url).pathname);
    // thisDir is packages/rigour-cli/dist/commands/
    // Sibling MCP package is at packages/rigour-mcp/dist/index.js
    const localMcpEntry = path.resolve(thisDir, '../../../rigour-mcp/dist/index.js');
    if (fs.existsSync(localMcpEntry)) {
        // Running from local dev checkout — use local path
        return { command: 'node', args: [localMcpEntry] };
    }
    return { command: 'npx', args: ['-y', mcpPackageSpec(getCliVersion())] };
}

/**
 * The MCP server pinned to this CLI's major version (`@rigour-labs/mcp@6`): fixes
 * arrive without editing the config, a breaking major does not, and a bare name
 * (which makes npx run any older global install) is never written.
 */
export function mcpPackageSpec(cliVersion: string): string {
    const major = /^(\d+)\./.exec(cliVersion)?.[1];
    return major && major !== '0' ? `@rigour-labs/mcp@${major}` : '@rigour-labs/mcp@latest';
}

/** The Rigour MCP server for the agents set up: Cursor in .cursor/mcp.json, Claude Code in .mcp.json. */
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
            console.log(chalk.yellow('  Kept .cursor/mcp.json: it is not valid JSON, so the Rigour MCP server was not added to it.'));
            return;
        }
        // Don't overwrite if rigour already registered (unless --force)
        if (existing?.mcpServers?.rigour && !force) {
            return;
        }
    }

    const created = !(await fs.pathExists(mcpPath));
    if (!existing.mcpServers) existing.mcpServers = {};
    existing.mcpServers.rigour = serverConfig;

    await fs.writeJson(mcpPath, existing, { spaces: 4 });
    if (created) recordCreated(cwd, path.join('.cursor', 'mcp.json'), await fs.readFile(mcpPath, 'utf-8'));
    console.log(chalk.green('✔ Registered Rigour MCP server (.cursor/mcp.json)'));
}

/**
 * Claude Code reads a project's MCP servers from `.mcp.json` at the repository root, not from
 * `.claude/settings.json` (which holds hooks and permissions). The server is merged into an
 * existing `.mcp.json`; an entry an older Rigour put in `.claude/settings.json` is taken out.
 */
async function setupClaudeMCP(
    cwd: string,
    serverConfig: { command: string; args: string[] },
    force?: boolean,
): Promise<void> {
    const mcpPath = path.join(cwd, '.mcp.json');
    const created = !(await fs.pathExists(mcpPath));
    let existing: any = {};
    if (!created) {
        try {
            existing = await fs.readJson(mcpPath);
        } catch {
            console.log(chalk.yellow('  Kept .mcp.json: it is not valid JSON, so the Rigour MCP server was not added to it.'));
            return;
        }
        if (existing?.mcpServers?.rigour && !force) return;
    }
    if (!existing.mcpServers) existing.mcpServers = {};
    existing.mcpServers.rigour = serverConfig;
    await fs.writeJson(mcpPath, existing, { spaces: 4 });
    if (created) recordCreated(cwd, '.mcp.json', await fs.readFile(mcpPath, 'utf-8'));

    // The old, unread location.
    const settingsPath = path.join(cwd, '.claude', 'settings.json');
    try {
        const settings = await fs.readJson(settingsPath);
        if (settings?.mcpServers?.rigour) {
            delete settings.mcpServers.rigour;
            if (Object.keys(settings.mcpServers).length === 0) delete settings.mcpServers;
            await fs.writeJson(settingsPath, settings, { spaces: 4 });
        }
    } catch {
        // no settings file, or not ours to repair
    }
    console.log(chalk.green('✔ Registered Rigour MCP server (.mcp.json)'));
}
