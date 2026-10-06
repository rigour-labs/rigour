/**
 * `rigour setup`: make this repository ready in one command, then say what works.
 *
 * The first time it writes rigour.yml, the agent hooks and agent instructions (rigour init); later
 * runs only add hooks that are missing (rigour hooks init never overwrites). It ends with the same
 * checks as rigour doctor and the one step it cannot do itself: connecting the MCP server.
 * It also installs semantic search once per machine (semantic.ts) unless --no-semantic.
 * `rigour uninstall` takes it all back out.
 */
import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import { printRepoSetup } from './doctor.js';
import { hooksInitCommand } from './hooks.js';
import { initCommand } from './init.js';
import { checkRepoSetup } from './repo-setup.js';
import { setupSemantic } from './semantic.js';

const MCP_SERVER = '{ "rigour": { "command": "npx", "args": ["-y", "@rigour-labs/mcp@latest"] } }';

export async function setupCommand(cwd = process.cwd(), options: { semantic?: boolean } = {}): Promise<void> {
    console.log(chalk.bold.cyan('\nRigour setup\n'));
    if (fs.existsSync(path.join(cwd, 'rigour.yml'))) await hooksInitCommand(cwd, {});
    else await initCommand(cwd, {});
    if (options.semantic !== false) await setupSemantic(cwd);

    await printRepoSetup(cwd);
    if ((await checkRepoSetup(cwd)).find(c => c.id === 'mcp')?.state === 'missing') {
        console.log(chalk.bold('One step left: give your agent the Rigour tools'));
        console.log(`  Claude Code: ${chalk.cyan('claude mcp add rigour -- npx -y @rigour-labs/mcp@latest')}`);
        console.log(`  Other agents: add to their MCP servers ${chalk.dim(MCP_SERVER)}\n`);
    }
    console.log(`See what Rigour does as your agents work: ${chalk.cyan('rigour studio')}\n`);
}
