/** Config loading shared by the review commands. */
import fs from 'fs-extra';
import path from 'path';
import yaml from 'yaml';
import { ConfigSchema, readStateFile, type Config } from '@rigour-labs/core';

/** A mistake in how the command was called (exit code 2), not an internal error. */
export class UsageError extends Error {}

/** The config file a command reads: the one named by -c, else rigour.yml at the repository root. */
function configFile(cwd: string, options: { config?: string }): string {
    return options.config ? path.resolve(cwd, options.config) : path.join(cwd, 'rigour.yml');
}

/**
 * rigour.yml, the file named by -c, or Rigour's defaults when the repository has none.
 * With `trustedRef`, the file as of that commit: a change cannot loosen the review of itself.
 */
export async function loadConfig(cwd: string, options: { config?: string }, trustedRef?: string): Promise<Config> {
    if (trustedRef) {
        const content = readStateFile(cwd, path.relative(cwd, configFile(cwd, options)), trustedRef);
        return ConfigSchema.parse(content === null ? {} : yaml.parse(content));
    }
    const configPath = configFile(cwd, options);
    if (await fs.pathExists(configPath)) return ConfigSchema.parse(yaml.parse(await fs.readFile(configPath, 'utf-8')));
    if (options.config) throw new UsageError(`Config file not found: ${configPath}`);
    return ConfigSchema.parse({});
}

/** Which settings loadConfig read, for a report that must say what was checked: a path, `<path> at <ref>`, or `defaults`. */
export function configSource(cwd: string, options: { config?: string }, trustedRef?: string): string {
    const rel = path.relative(cwd, configFile(cwd, options)).split(path.sep).join('/');
    if (trustedRef) return readStateFile(cwd, rel, trustedRef) === null ? 'defaults' : `${rel} at ${trustedRef}`;
    return fs.existsSync(configFile(cwd, options)) ? rel : 'defaults';
}
