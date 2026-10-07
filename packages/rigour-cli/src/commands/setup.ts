/**
 * `rigour setup`: make this repository ready in one command, then say what works.
 *
 * Personal (the default): nothing in the working tree. Agent hooks are installed once per machine
 * at user level, guarded so they run only where Rigour is switched on; this repository is switched
 * on inside its git directory (personal.ts). For trying Rigour, or using it alone.
 *
 * Team (`--team`, or a repository that already commits a rigour.yml): rigour.yml, the project's
 * agent hooks and its MCP server are written into the repository, so everyone who clones gets the
 * same gate. Agent instruction files only with `--instructions`.
 *
 * Both install semantic search once per machine (semantic.ts) unless --no-semantic, end with the
 * same checks as `rigour doctor`, and are taken back out by `rigour uninstall`.
 */
import chalk from 'chalk';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { printRepoSetup } from './doctor.js';
import { installGitPushHook } from './hooks-git.js';
import { hooksInitCommand, installMachineHooks, pinnedCliCommand } from './hooks.js';
import { initCommand, resolveMCPServerConfig } from './init.js';
import { writeAgentInstructions } from './init-handshake.js';
import { disableHere, enableHere, registerUserMcp } from './personal.js';
import { setupSemantic } from './semantic.js';

const AGENT_NAME = { claude: 'Claude Code', cursor: 'Cursor', cline: 'Cline', windsurf: 'Windsurf' } as const;

export interface SetupOptions {
    semantic?: boolean;
    team?: boolean;
    instructions?: boolean;
}

export async function setupCommand(cwd = process.cwd(), options: SetupOptions = {}): Promise<void> {
    const team = options.team || committedConfig(cwd);
    console.log(chalk.bold.cyan(`\nRigour setup (${team ? 'team: committed to this repository' : 'personal: nothing in your working tree'})\n`));
    if (team) await teamSetup(cwd, options);
    else await personalSetup(cwd);
    if (options.semantic !== false) await setupSemantic(cwd);
    await printRepoSetup(cwd);
    console.log(`See what Rigour does as your agents work: ${chalk.cyan('rigour studio')}`);
    console.log(chalk.dim(`Take it back out: rigour uninstall${team ? '' : ' (this repository) or rigour uninstall --machine (everywhere)'}\n`));
}

async function personalSetup(cwd: string): Promise<void> {
    if (!enableHere(cwd)) {
        console.log(chalk.yellow('Not a git repository: Rigour switches on per repository. Run it inside one.'));
        return;
    }
    const hooks = await installMachineHooks({ block: true, dlp: true });
    const push = installGitPushHook(cwd, pinnedCliCommand(), { workingTree: false });
    const mcp = registerUserMcp(resolveMCPServerConfig());
    console.log('');
    console.log(chalk.green('✔ Switched on for this repository (a marker and .rigour/ in .git/info/exclude; nothing to commit)'));
    console.log(chalk.green(`✔ Agent hooks for ${hooks.agents.map(agent => AGENT_NAME[agent]).join(', ')}, the agents installed here, once per machine (${hooks.written} config(s) merged or written; they stay silent in repositories you have not switched on)`));
    for (const failed of hooks.failed) console.log(chalk.yellow(`  Left alone: ~/${failed} is not valid JSON`));
    if (push.action === 'managed elsewhere') console.log(chalk.yellow(`Git pre-push hooks are managed outside this repository (${push.path}); add: ${pinnedCliCommand()} hooks push --git "$@" || exit $?`));
    else if (push.action !== 'no repository') console.log(chalk.green(`✔ Push gate: git's pre-push hook (${push.action})`));
    if (mcp.claude === 'no CLI') console.log(chalk.yellow(`Claude Code MCP: add it with ${chalk.cyan(`claude mcp add --scope user rigour -- ${[resolveMCPServerConfig().command, ...resolveMCPServerConfig().args].join(' ')}`)}`));
    else console.log(chalk.green(`✔ Rigour tools for agents (MCP): Claude Code ${mcp.claude}, Cursor ${mcp.cursor}`));
}

async function teamSetup(cwd: string, options: SetupOptions): Promise<void> {
    // A personal switch here would run the machine hooks beside the committed ones.
    disableHere(cwd, false);
    if (fs.existsSync(path.join(cwd, 'rigour.yml'))) {
        // The same options the team's install was written with, so a teammate's setup changes no committed file.
        await hooksInitCommand(cwd, { block: true, dlp: true });
        if (options.instructions) await writeAgentInstructions(cwd);
    } else await initCommand(cwd, { instructions: options.instructions });
}

/** A rigour.yml the repository tracks: the team has adopted Rigour, so setup completes their install. */
function committedConfig(cwd: string): boolean {
    return spawnSync('git', ['ls-files', '--error-unmatch', 'rigour.yml'], { cwd, encoding: 'utf8' }).status === 0;
}
