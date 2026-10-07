/** Config loading shared by the review commands. */
import fs from 'fs-extra';
import path from 'path';
import yaml from 'yaml';
import { ConfigSchema, readStateFile, type Config } from '@rigour-labs/core';

/** A mistake in how the command was called (exit code 2), not an internal error. */
export class UsageError extends Error {}

/**
 * rigour.yml, the file named by -c, or Rigour's defaults when the repository has none.
 * With `trustedRef`, the file as of that commit: a change cannot loosen the review of itself.
 */
export async function loadConfig(cwd: string, options: { config?: string }, trustedRef?: string): Promise<Config> {
    if (trustedRef) {
        const rel = path.relative(cwd, options.config ? path.resolve(cwd, options.config) : path.join(cwd, 'rigour.yml'));
        const content = readStateFile(cwd, rel, trustedRef);
        return ConfigSchema.parse(content === null ? {} : yaml.parse(content));
    }
    const configPath = options.config ? path.resolve(cwd, options.config) : path.join(cwd, 'rigour.yml');
    if (await fs.pathExists(configPath)) return ConfigSchema.parse(yaml.parse(await fs.readFile(configPath, 'utf-8')));
    if (options.config) throw new UsageError(`Config file not found: ${configPath}`);
    return ConfigSchema.parse({});
}
