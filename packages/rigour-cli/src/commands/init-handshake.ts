/**
 * Agent instruction files, written by `rigour setup --team --instructions` only.
 *
 * One AGENTS.md, the file most coding agents read, and a CLAUDE.md that imports it for Claude Code.
 * Nothing per agent beyond that: the MCP tools describe themselves and the hooks enforce, so the
 * instructions only tell an agent what the hooks will hold it to. A file the project already has
 * is the team's own: it is kept unless --force is given, and the person is told what to add.
 */
import fs from 'fs-extra';
import path from 'path';
import chalk from 'chalk';
import { recordCreated } from './install-record.js';

/** Rigour's section of AGENTS.md: what the hooks check, and what an agent must not do to pass them. */
const AGENTS_SECTION = `## Rigour

This repository uses Rigour. Its hooks check your work after each edit, before you finish and before a push.

- Before you say a task is done, \`rigour review --base origin/main\` (or the \`rigour_review\` MCP tool) must show nothing to fix. Fix what it reports in your change.
- Before writing a new helper, ask \`rigour_check_pattern\` whether one already exists.
- Never edit \`rigour.yml\`, add an ignore, or dismiss a finding to make a check pass. Whether a finding is wrong is a person's call.
- Never push with \`--no-verify\`.
`;

const AGENTS_MD = `# Agent instructions\n\n${AGENTS_SECTION}`;
/** Claude Code reads CLAUDE.md, not AGENTS.md: one import line keeps a single source. */
const CLAUDE_MD = '@AGENTS.md\n';

export async function writeAgentInstructions(cwd: string, force?: boolean): Promise<void> {
    const agents = await writeIfAbsent(cwd, 'AGENTS.md', AGENTS_MD, force);
    if (!agents) console.log(chalk.dim('  Kept your AGENTS.md: add Rigour\'s section to it (https://github.com/rigour-labs/rigour/blob/main/docs/AGENTS.md#instructions), or re-run with --force to replace it.'));
    const claude = await writeIfAbsent(cwd, 'CLAUDE.md', CLAUDE_MD, force);
    if (!claude && !(await fs.readFile(path.join(cwd, 'CLAUDE.md'), 'utf8')).includes('@AGENTS.md')) {
        console.log(chalk.dim('  Kept your CLAUDE.md: add a line "@AGENTS.md" to it so Claude Code reads the same instructions.'));
    }
}

/** Writes the file unless the project has one (or --force); true when Rigour wrote it. */
async function writeIfAbsent(cwd: string, relPath: string, content: string, force?: boolean): Promise<boolean> {
    const filePath = path.join(cwd, relPath);
    const existed = await fs.pathExists(filePath);
    if (existed && !force) return false;
    await fs.writeFile(filePath, content);
    // Only a file Rigour created is Rigour's to remove later; one it replaced under --force was the team's.
    if (!existed) recordCreated(cwd, relPath, content);
    console.log(chalk.green(`✔ Agent instructions (${relPath})`));
    return true;
}
