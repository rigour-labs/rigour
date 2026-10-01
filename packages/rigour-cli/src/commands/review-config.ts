/** Config loading shared by the review commands. */
import fs from 'fs-extra';
import path from 'path';
import yaml from 'yaml';
import { ConfigSchema, type Config } from '@rigour-labs/core';

/** A mistake in how the command was called (exit code 2), not an internal error. */
export class UsageError extends Error {}

/** rigour.yml, the file named by -c, or Rigour's defaults when the repository has none. */
export async function loadConfig(cwd: string, options: { config?: string }): Promise<Config> {
    const configPath = options.config ? path.resolve(cwd, options.config) : path.join(cwd, 'rigour.yml');
    if (await fs.pathExists(configPath)) return ConfigSchema.parse(yaml.parse(await fs.readFile(configPath, 'utf-8')));
    if (options.config) throw new UsageError(`Config file not found: ${configPath}`);
    return ConfigSchema.parse({ version: 1 });
}
