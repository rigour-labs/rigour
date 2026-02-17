import fs from 'fs-extra';
import path from 'path';
import { Failure, Config } from '../types/index.js';
import { Gate, GateContext } from './base.js';

export class DependencyGate extends Gate {
    constructor(private config: Config) {
        super('dependency-guardian', 'Dependency Guardian');
    }

    async run(context: GateContext): Promise<Failure[]> {
        const failures: Failure[] = [];
        const forbidden = this.config.gates.dependencies?.forbid || [];

        if (forbidden.length === 0) return [];

        const { cwd } = context;

        // 1. Scan Node.js (package.json)
        const pkgPath = path.join(cwd, 'package.json');
        if (await fs.pathExists(pkgPath)) {
            try {
                const pkg = await fs.readJson(pkgPath);
                const allDeps = {
                    ...(pkg.dependencies || {}),
                    ...(pkg.devDependencies || {}),
                    ...(pkg.peerDependencies || {}),
                };

                for (const dep of forbidden) {
                    if (allDeps[dep]) {
                        failures.push(this.createFailure(
                            `The package '${dep}' is forbidden by project standards.`,
                            ['package.json'],
                            `Remove '${dep}' from package.json and use approved alternatives.`,
                            'Forbidden Dependency',
                            undefined,
                            undefined,
                            'medium'
                        ));
                    }
                }
            } catch (e) { }
        }

        // 2. Scan Python (requirements.txt, pyproject.toml)
        const reqPath = path.join(cwd, 'requirements.txt');
        if (await fs.pathExists(reqPath)) {
            const content = await fs.readFile(reqPath, 'utf-8');
            for (const dep of forbidden) {
                if (new RegExp(`^${dep}([=<>! ]|$)`, 'm').test(content)) {
                    failures.push(this.createFailure(
                        `The Python package '${dep}' is forbidden.`,
                        ['requirements.txt'],
                        `Remove '${dep}' from requirements.txt.`,
                        'Forbidden Dependency',
                        undefined,
                        undefined,
                        'medium'
                    ));
                }
            }
        }

        const pyprojPath = path.join(cwd, 'pyproject.toml');
        if (await fs.pathExists(pyprojPath)) {
            const content = await fs.readFile(pyprojPath, 'utf-8');
            for (const dep of forbidden) {
                if (new RegExp(`^${dep}\\s*=`, 'm').test(content)) {
                    failures.push(this.createFailure(
                        `The Python package '${dep}' is forbidden in pyproject.toml.`,
                        ['pyproject.toml'],
                        `Remove '${dep}' from pyproject.toml dependencies.`,
                        'Forbidden Dependency',
                        undefined,
                        undefined,
                        'medium'
                    ));
                }
            }
        }

        // 3. Scan Go (go.mod)
        const goModPath = path.join(cwd, 'go.mod');
        if (await fs.pathExists(goModPath)) {
            const content = await fs.readFile(goModPath, 'utf-8');
            for (const dep of forbidden) {
                if (content.includes(dep)) {
                    failures.push(this.createFailure(
                        `The Go module '${dep}' is forbidden.`,
                        ['go.mod'],
                        `Remove '${dep}' from go.mod.`,
                        'Forbidden Dependency',
                        undefined,
                        undefined,
                        'medium'
                    ));
                }
            }
        }

        // 4. Scan Java (pom.xml)
        const pomPath = path.join(cwd, 'pom.xml');
        if (await fs.pathExists(pomPath)) {
            const content = await fs.readFile(pomPath, 'utf-8');
            for (const dep of forbidden) {
                if (content.includes(`<artifactId>${dep}</artifactId>`)) {
                    failures.push(this.createFailure(
                        `The Java artifact '${dep}' is forbidden.`,
                        ['pom.xml'],
                        `Remove '${dep}' from pom.xml.`,
                        'Forbidden Dependency',
                        undefined,
                        undefined,
                        'medium'
                    ));
                }
            }
        }

        return failures;
    }
}
