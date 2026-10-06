/**
 * Agent handshake files written by `rigour init` (CLAUDE.md, AGENTS.md, ...).
 *
 * A file the project already has is the team's own instructions: it is kept
 * unless --force is given, and the user is told, because otherwise the agent
 * silently never sees Rigour's rules.
 */
import fs from 'fs-extra';
import path from 'path';
import chalk from 'chalk';
import { recordCreated } from './install-record.js';

export async function writeHandshake(cwd: string, relPath: string, content: string, label: string, force?: boolean): Promise<void> {
    const filePath = path.join(cwd, relPath);
    if (!force && await fs.pathExists(filePath)) {
        console.log(chalk.dim(`  Kept existing ${relPath}; Rigour's rules were not added to it. ` +
            'Merge them from docs/AGENT_INSTRUCTIONS.md, or re-run with --force to replace the file.'));
        return;
    }
    const existed = await fs.pathExists(filePath);
    await fs.ensureDir(path.dirname(filePath));
    await fs.writeFile(filePath, content);
    // Only a file Rigour created is Rigour's to remove later; one it replaced under --force was the team's.
    if (!existed) recordCreated(cwd, relPath, content);
    console.log(chalk.green(`✔ Initialized ${label} (${relPath})`));
}

/**
 * Cline reads rules from a `.clinerules` file (legacy) or every file in a
 * `.clinerules/` folder, and its hooks live in `.clinerules/hooks/`. Use the
 * folder so the hooks can be installed, unless the project has the legacy file.
 */
export async function clineRulesRelPath(cwd: string): Promise<string> {
    const legacy = path.join(cwd, '.clinerules');
    const isLegacyFile = await fs.pathExists(legacy) && (await fs.stat(legacy)).isFile();
    return isLegacyFile ? '.clinerules' : path.join('.clinerules', 'rigour.md');
}
