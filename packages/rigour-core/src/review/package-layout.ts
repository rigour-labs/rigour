/**
 * What a package's own files say about a source file: whether it is the package's entry point
 * (its exports are the public API, used outside the repository), and whether its project emits
 * declarations (an exported type named in another export's signature must stay exported).
 * Compiled paths in package.json (dist/, lib/, build/, out/) are mapped back to sources.
 */
import fs from 'fs';
import path from 'path';

const COMPILED_DIR = /^(dist|lib|build|out)\//;
const COMPILED_EXT = /\.(d\.ts|d\.mts|js|mjs|cjs)$/;

/** A path a package or script names, as the source file it was compiled from: `dist/bin.js` → `src/bin`. */
export function sourceStem(relative: string): string {
    return relative.replace(/^\.\//, '').replace(COMPILED_DIR, 'src/').replace(COMPILED_EXT, '').replace(/\.(ts|tsx|mts|cts)$/, '');
}

/** The source files a package.json points at (main, module, types, bin, exports), as repository-relative stems. */
function packageEntryStems(cwd: string, packageJson: string): string[] {
    let pkg: any;
    try {
        pkg = JSON.parse(fs.readFileSync(path.join(cwd, packageJson), 'utf8'));
    } catch {
        return [];
    }
    const dir = path.posix.dirname(packageJson);
    const targets: string[] = [];
    const collect = (value: unknown) => {
        if (typeof value === 'string') targets.push(value);
        else if (value && typeof value === 'object') Object.values(value).forEach(collect);
    };
    [pkg.main, pkg.module, pkg.types, pkg.typings, pkg.exports, pkg.bin].forEach(collect);
    return targets.filter(t => t.startsWith('./') || !t.startsWith('.')).map(t => path.posix.normalize(path.posix.join(dir, sourceStem(t))));
}

/**
 * Whether `file` is part of a package's public surface: an entry point a package.json on its path
 * names, or a module an entry re-exports whole (`export * from './hooks/index.js'`), followed down.
 */
export function isPackageEntry(cwd: string, file: string): boolean {
    const stem = file.replace(/\.(ts|tsx|mts|cts|js|jsx|mjs|svelte)$/, '');
    for (let dir = path.posix.dirname(file); ; dir = path.posix.dirname(dir)) {
        const candidate = dir === '.' ? 'package.json' : `${dir}/package.json`;
        if (fs.existsSync(path.join(cwd, candidate)) && publicStems(cwd, candidate).has(stem)) return true;
        if (dir === '.' || dir === '/') return false;
    }
}

const publicCache = new Map<string, Set<string>>();

/** Entry stems plus every module they re-export whole, transitively. */
function publicStems(cwd: string, packageJson: string): Set<string> {
    const key = `${cwd}\0${packageJson}`;
    const cached = publicCache.get(key);
    if (cached) return cached;
    const stems = new Set<string>();
    const queue = packageEntryStems(cwd, packageJson);
    while (queue.length) {
        const stem = queue.shift()!;
        if (stems.has(stem)) continue;
        stems.add(stem);
        const text = readSource(cwd, stem);
        for (const match of text.matchAll(/export\s+\*\s+(?:as\s+\w+\s+)?from\s+['"](\.[^'"]+)['"]/g)) {
            queue.push(path.posix.normalize(path.posix.join(path.posix.dirname(stem), match[1].replace(COMPILED_EXT, '').replace(/\.(ts|tsx|mts|cts)$/, ''))));
        }
    }
    publicCache.set(key, stems);
    return stems;
}

function readSource(cwd: string, stem: string): string {
    for (const ext of ['.ts', '.tsx', '.mts', '.js', '.mjs']) {
        try {
            return fs.readFileSync(path.join(cwd, stem + ext), 'utf8');
        } catch {
            // try the next extension
        }
    }
    return '';
}

/** Whether the TypeScript project around `file` emits declarations (declaration or composite, following extends). */
export function emitsDeclarations(cwd: string, file: string): boolean {
    for (let dir = path.posix.dirname(file); ; dir = path.posix.dirname(dir)) {
        const tsconfig = path.join(cwd, dir === '.' ? 'tsconfig.json' : `${dir}/tsconfig.json`);
        if (fs.existsSync(tsconfig)) return declarationsIn(tsconfig, 0);
        if (dir === '.' || dir === '/') return false;
    }
}

function declarationsIn(tsconfig: string, depth: number): boolean {
    let config: any;
    try {
        config = JSON.parse(fs.readFileSync(tsconfig, 'utf8').replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1'));
    } catch {
        return false;
    }
    const options = config?.compilerOptions ?? {};
    if (typeof options.declaration === 'boolean' || typeof options.composite === 'boolean') return options.declaration === true || options.composite === true;
    if (typeof config?.extends === 'string' && config.extends.startsWith('.') && depth < 5) {
        const parent = path.resolve(path.dirname(tsconfig), config.extends.endsWith('.json') ? config.extends : `${config.extends}.json`);
        return declarationsIn(parent, depth + 1);
    }
    return false;
}
