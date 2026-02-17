import { Gate, GateContext } from './base.js';
import { Failure, Gates } from '../types/index.js';
import { execa } from 'execa';
import semver from 'semver';
import fs from 'fs-extra';
import path from 'path';

export class EnvironmentGate extends Gate {
    constructor(private config: Gates) {
        super('environment-alignment', 'Environment & Tooling Alignment');
    }

    async run(context: GateContext): Promise<Failure[]> {
        const failures: Failure[] = [];
        const envConfig = this.config.environment;
        if (!envConfig || !envConfig.enabled) return [];

        const contracts = envConfig.enforce_contracts ? await this.discoverContracts(context.cwd) : {};
        const toolsToCheck = { ...contracts, ...(envConfig.tools || {}) };

        // 1. Verify Tool Versions
        for (const [tool, range] of Object.entries(toolsToCheck)) {
            // Ensure range is a string
            const semverRange = String(range);
            try {
                const { stdout } = await execa(tool, ['--version'], { shell: true });
                const versionMatch = stdout.match(/(\d+\.\d+\.\d+)/);

                if (versionMatch) {
                    const version = versionMatch[1];
                    if (!semver.satisfies(version, semverRange)) {
                        failures.push(this.createFailure(
                            `Environment Alignment: Tool '${tool}' version mismatch.`,
                            [],
                            `Project requires '${tool} ${semverRange}' (discovered from contract), but found version '${version}'. Please align your local environment to prevent drift.`,
                            undefined,
                            undefined,
                            undefined,
                            'medium'
                        ));
                    }
                } else {
                    failures.push(this.createFailure(
                        `Environment Alignment: Could not determine version for '${tool}'.`,
                        [],
                        `Ensure '${tool} --version' returns a standard SemVer string.`,
                        undefined,
                        undefined,
                        undefined,
                        'medium'
                    ));
                }
            } catch (e) {
                failures.push(this.createFailure(
                    `Environment Alignment: Required tool '${tool}' is missing.`,
                    [],
                    `Install '${tool}' and ensure it is in your $PATH.`,
                    undefined,
                    undefined,
                    undefined,
                    'medium'
                ));
            }
        }

        // 2. Verify Required Env Vars
        const requiredEnv = envConfig.required_env || [];
        for (const envVar of requiredEnv) {
            if (!process.env[envVar]) {
                failures.push(this.createFailure(
                    `Environment Alignment: Missing required environment variable '${envVar}'.`,
                    [],
                    `Ensure '${envVar}' is defined in your environment or .env file.`,
                    undefined,
                    undefined,
                    undefined,
                    'medium'
                ));
            }
        }

        return failures;
    }

    private async discoverContracts(cwd: string): Promise<Record<string, string>> {
        const contracts: Record<string, string> = {};

        // 1. Scan pyproject.toml (for ruff, mypy)
        const pyprojectPath = path.join(cwd, 'pyproject.toml');
        if (await fs.pathExists(pyprojectPath)) {
            const content = await fs.readFile(pyprojectPath, 'utf-8');
            // SME Logic: Look for ruff and mypy version constraints
            // Handle both ruff = "^0.14.0" and ruff = { version = "^0.14.0" }
            const ruffMatch = content.match(/ruff\s*=\s*(?:['"]([^'"]+)['"]|\{\s*version\s*=\s*['"]([^'"]+)['"]\s*\})/);
            if (ruffMatch) contracts['ruff'] = ruffMatch[1] || ruffMatch[2];

            const mypyMatch = content.match(/mypy\s*=\s*(?:['"]([^'"]+)['"]|\{\s*version\s*=\s*['"]([^'"]+)['"]\s*\})/);
            if (mypyMatch) contracts['mypy'] = mypyMatch[1] || mypyMatch[2];
        }

        // 2. Scan package.json (for node/npm/pnpm)
        const pkgPath = path.join(cwd, 'package.json');
        if (await fs.pathExists(pkgPath)) {
            const pkg = await fs.readJson(pkgPath);
            if (pkg.engines?.node) contracts['node'] = pkg.engines.node;
        }

        return contracts;
    }
}
