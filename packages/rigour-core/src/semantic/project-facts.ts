/**
 * What a file's own package declares: its nearest package.json dependencies and
 * nearest tsconfig compiler options. Ecosystem rules are gated on these, so a
 * Solid rule only runs where Solid is a dependency, and in a monorepo each
 * package is judged by its own manifest. Lookups never leave `cwd`, and are
 * cached for one analysis run.
 */
import fs from 'fs';
import path from 'path';
import ts from 'typescript';

interface Manifest {
    name?: string;
    dependencies: Map<string, string>;
    /** Every range declared for a name, across dependency fields. */
    ranges: Map<string, string[]>;
}

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const;

export class ProjectFacts {
    private readonly packages = new Map<string, Manifest | null>();
    private readonly options = new Map<string, ts.CompilerOptions>();

    constructor(private readonly cwd: string) {}

    /** Declared dependency names and version ranges of the package that owns `file`. */
    dependencies(file: string): Map<string, string> {
        return this.nearestPackage(file)?.dependencies ?? new Map();
    }

    /** Directory of the package.json that owns `file`. */
    packageDir(file: string): string | undefined {
        return this.dirsUp(file).find(dir => this.readPackage(dir));
    }

    /** The `name` of the package that owns `file`. */
    packageName(file: string): string | undefined {
        return this.nearestPackage(file)?.name;
    }

    declares(file: string, ...names: string[]): boolean {
        const deps = this.dependencies(file);
        return names.some(name => deps.has(name));
    }

    /**
     * Highest major version a declared dependency may run on, across every field
     * and `||` alternative (`>=18.0.0 || >=19.0.0` -> 19). A package that supports
     * a major must work on it. Undefined when no range names a version (`catalog:`, `workspace:*`).
     */
    majorVersion(file: string, name: string): number | undefined {
        const majors = (this.nearestPackage(file)?.ranges.get(name) ?? [])
            .flatMap(range => range.split('||'))
            .map(alternative => alternative.match(/(\d+)(?:\.[\dx*]+)*/)?.[1])
            .filter((m): m is string => m !== undefined)
            .map(Number);
        return majors.length ? Math.max(...majors) : undefined;
    }

    /** Compiler options of the nearest tsconfig.json above `file`, extends resolved. */
    compilerOptions(file: string): ts.CompilerOptions {
        const dir = path.dirname(path.resolve(this.cwd, file));
        const cached = this.options.get(dir);
        if (cached) return cached;
        const configPath = this.dirsUp(file).map(d => path.join(d, 'tsconfig.json')).find(p => fs.existsSync(p));
        let options: ts.CompilerOptions = {};
        if (configPath) {
            const read = ts.readConfigFile(configPath, ts.sys.readFile);
            if (!read.error) options = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(configPath)).options;
        }
        this.options.set(dir, options);
        return options;
    }

    private dirsUp(file: string): string[] {
        const root = path.resolve(this.cwd);
        const dirs: string[] = [];
        for (let dir = path.dirname(path.resolve(root, file)); dir.startsWith(root); dir = path.dirname(dir)) {
            dirs.push(dir);
            if (dir === root) break;
        }
        return dirs;
    }

    private nearestPackage(file: string): Manifest | undefined {
        for (const dir of this.dirsUp(file)) {
            const manifest = this.readPackage(dir);
            if (manifest) return manifest;
        }
        return undefined;
    }

    private readPackage(dir: string): Manifest | null {
        if (this.packages.has(dir)) return this.packages.get(dir)!;
        let manifest: Manifest | null = null;
        try {
            const json = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
            const dependencies = new Map<string, string>();
            const ranges = new Map<string, string[]>();
            for (const field of DEPENDENCY_FIELDS) {
                for (const [name, range] of Object.entries(json[field] ?? {})) {
                    dependencies.set(name, String(range));
                    ranges.set(name, [...(ranges.get(name) ?? []), String(range)]);
                }
            }
            manifest = { name: typeof json.name === 'string' ? json.name : undefined, dependencies, ranges };
        } catch {
            manifest = null;
        }
        this.packages.set(dir, manifest);
        return manifest;
    }
}
