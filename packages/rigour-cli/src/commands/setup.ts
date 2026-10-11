/**
 * `rigour setup`: make this repository ready in one command, then say what works.
 *
 * Personal (the default): nothing in the working tree. Agent hooks are installed once per machine
 * at user level, guarded so they run only where Rigour is switched on; this repository is switched
 * on inside its git directory (personal.ts). For trying Rigour, or using it alone.
 *
 * Team (`--team`): rigour.yml, the project's agent hooks and its MCP server are written into the
 * repository, so everyone who clones gets the same gate. Agent instruction files only with
 * `--instructions`. Only `--team` ever writes into the working tree: in a repository that commits its
 * own Rigour hooks, a plain `rigour setup` leaves every file as committed (the team's install runs).
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
import { hooksInitCommand, installMachineHooks, pinnedCliCommand, projectHookPaths } from './hooks.js';
import { initCommand, registerProjectMcp, resolveMCPServerConfig } from './init.js';
import { writeAgentInstructions } from './init-handshake.js';
import { disableHere, enableHere, registerUserMcp } from './personal.js';
import { applyConfigMigrations, isOldEditHook } from './setup-migrations.js';
import { getCliVersion } from '../utils/cli-version.js';
import { setupSemantic } from './semantic.js';
import { setReportOnlyHere } from './report-only.js';
import yaml from 'yaml';

const AGENT_NAME = { claude: 'Claude Code', cursor: 'Cursor', cline: 'Cline', windsurf: 'Windsurf' } as const;

export interface SetupOptions {
    semantic?: boolean;
    /** The team's briefing for the agent (the session's first prompt, each file's first edit): on unless false (--no-brief). */
    brief?: boolean;
    team?: boolean;
    instructions?: boolean;
    /** A team's first week: every gate says what it would have blocked and blocks nothing (report-only.ts). */
    reportOnly?: boolean;
    /** Every gate blocks again (clears report-only). */
    block?: boolean;
}

export async function setupCommand(cwd = process.cwd(), options: SetupOptions = {}): Promise<void> {
    const team = !!options.team;
    const committed = team ? [] : committedRigourHooks(cwd);
    const mode = team ? 'team: committed to this repository' : committed.length ? "the team's install: nothing in your working tree" : 'personal: nothing in your working tree';
    console.log(chalk.bold.cyan(`\nRigour setup (${mode})\n`));
    if (team) {
        const touched = trackedFiles(cwd, ['rigour.yml', ...rigourInstallPaths()]);
        if (touched.length) console.log(chalk.yellow(`Writes into these committed files (commit the result so everyone gets it): ${touched.join(', ')}\n`));
        await teamSetup(cwd, options);
    } else if (committed.length) await leaveTeamInstall(cwd, committed, !!options.instructions);
    else {
        if (trackedFiles(cwd, ['rigour.yml']).length) console.log(chalk.dim('This repository commits rigour.yml; `rigour setup --team` commits hooks for everyone. This setup is yours alone.\n'));
        await personalSetup(cwd, options.brief !== false);
    }
    // rigour.yml is the team's file: only --team changes it (doctor's checks below name what is due).
    if (team) for (const change of applyConfigMigrations(cwd)) console.log(chalk.green(`✔ Migrated ${change}`));
    if (options.reportOnly || options.block) setGateMode(cwd, team, !!options.reportOnly);
    if (options.semantic !== false) await setupSemantic(cwd);
    await printRepoSetup(cwd);
    console.log(`See what Rigour does as your agents work: ${chalk.cyan('rigour studio')}`);
    console.log(chalk.dim(`Take it back out: rigour uninstall${team ? '' : ' (this repository) or rigour uninstall --machine (everywhere)'}\n`));
}

async function personalSetup(cwd: string, brief: boolean): Promise<void> {
    if (!enableHere(cwd)) {
        console.log(chalk.yellow('Not a git repository: Rigour switches on per repository. Run it inside one.'));
        return;
    }
    const hooks = await installMachineHooks({ block: true, dlp: true, brief });
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
        await hooksInitCommand(cwd, { block: true, dlp: true, brief: options.brief !== false });
        await registerProjectMcp(cwd);
        if (options.instructions) await writeAgentInstructions(cwd);
    } else await initCommand(cwd, { instructions: options.instructions, brief: options.brief !== false });
}

/**
 * Report-only or blocking, for this repository: the person's switch in the git directory, and with --team the team's
 * in rigour.yml (`hooks.report_only`), so everyone who clones starts the same way.
 */
function setGateMode(cwd: string, team: boolean, report: boolean): void {
    setReportOnlyHere(cwd, report);
    const file = path.join(cwd, 'rigour.yml');
    if (team && fs.existsSync(file)) {
        const doc = yaml.parseDocument(fs.readFileSync(file, 'utf8'));
        if (report) doc.setIn(['hooks', 'report_only'], true);
        else doc.deleteIn(['hooks', 'report_only']);
        fs.writeFileSync(file, doc.toString());
    }
    console.log(report
        ? chalk.green(`✔ Report only: the edit check, the stop review and the push gate say what they would block and block nothing${team ? ' (hooks.report_only in rigour.yml)' : ''}. A real credential is still refused. Make them block: rigour setup${team ? ' --team' : ''} --block`)
        : chalk.green('✔ The edit check, the stop review and the push gate block again.'));
}

/**
 * The team's install, as committed here: tracked project hook and MCP files that run Rigour. Their agents already run
 * them, so a person's setup changes none of them, and personal hooks beside them would run every check twice.
 */
async function leaveTeamInstall(cwd: string, committed: string[], instructions: boolean): Promise<void> {
    disableHere(cwd, false);
    const text = committed.map(file => fs.readFileSync(path.join(cwd, file), 'utf8')).join('\n');
    const pins = [...new Set([...text.matchAll(/@rigour-labs\/cli@([0-9A-Za-z.-]+)/g)].map(m => m[1]))];
    const installed = getCliVersion();
    const stale = pins.filter(pin => pin !== installed);
    console.log(chalk.green('✔ This repository commits its own Rigour install, and your agents run it. Left as committed:'));
    for (const file of committed) console.log(chalk.dim(`    ${file}`));
    if (stale.length) {
        // The committed pin is what the agents run: name it, and what it costs, since this setup does not move it.
        const caveat = isOldEditHook(text) ? ' (its edit hook checks nothing)' : '';
        console.log(chalk.yellow(`  These hooks pin Rigour ${pins.join(', ')}; they keep running that version${caveat} until someone runs \`rigour setup --team\` and commits the result. Installed here: ${installed}.`));
    } else console.log(chalk.dim('  To change it for everyone: rigour setup --team, then commit the result.'));
    // This clone's own: git's pre-push hook lives in the git directory, never in the working tree.
    const push = installGitPushHook(cwd, pinnedCliCommand(), { workingTree: false });
    if (push.action === 'managed elsewhere') console.log(chalk.yellow(`Git pre-push hooks are managed outside this repository (${push.path}); add: ${pinnedCliCommand()} hooks push --git "$@" || exit $?`));
    else if (push.action !== 'no repository') console.log(chalk.green(`✔ Push gate: git's pre-push hook (${push.action}); the only thing installed here`));
    // Asked for by name: written only where the repository has none, so no committed file changes.
    if (instructions) await writeAgentInstructions(cwd);
}

/** Where a team's Rigour install lives in the repository: the project hook and MCP configs. */
function rigourInstallPaths(): string[] {
    return [...projectHookPaths(), '.mcp.json', '.cursor/mcp.json'];
}

/** Which of these paths git tracks here. */
function trackedFiles(cwd: string, paths: string[]): string[] {
    const tracked = spawnSync('git', ['ls-files', '--', ...paths], { cwd, encoding: 'utf8' });
    return tracked.status === 0 ? tracked.stdout.split('\n').filter(Boolean) : [];
}

/** The tracked files of a team's Rigour install: project hook and MCP configs that name Rigour. */
function committedRigourHooks(cwd: string): string[] {
    return trackedFiles(cwd, rigourInstallPaths()).filter(file => {
        try {
            return /rigour/i.test(fs.readFileSync(path.join(cwd, file), 'utf8'));
        } catch {
            return false;
        }
    });
}
