import fs from 'fs-extra';
import path from 'path';

const sourceExtensions = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.d.ts'];

/** TypeScript ESM imports name the emitted file: `utils.js` for `utils.ts`. */
const RUNTIME_TO_SOURCE: Record<string, string[]> = {
    '.js': ['.ts', '.tsx', '.d.ts'],
    '.jsx': ['.tsx'],
    '.mjs': ['.mts', '.d.mts'],
    '.cjs': ['.cts', '.d.cts'],
};

function sourceSiblings(target: string): string[] {
    const extension = path.extname(target);
    const sources = RUNTIME_TO_SOURCE[extension];
    if (!sources) return [];
    const base = target.slice(0, -extension.length);
    return sources.map(source => base + source);
}

export async function resolveTsPathTarget(
    baseDir: string,
    candidatePattern: string,
    cwd: string,
    projectFiles: Set<string>,
): Promise<boolean> {
    const absolute = path.resolve(baseDir, candidatePattern);
    const relative = path.relative(cwd, absolute).replace(/\\/g, '/');
    if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) return false;

    const normalized = relative.replace(/\/$/, '');
    const candidates = [
        ...sourceExtensions.map(extension => normalized + extension),
        ...sourceExtensions.map(extension => `${normalized}/index${extension}`),
        ...sourceSiblings(normalized),
    ];
    if (candidates.some(candidate => projectFiles.has(candidate))) return true;

    for (const candidate of candidates) {
        const candidatePath = path.resolve(cwd, candidate);
        if (!await fs.pathExists(candidatePath)) continue;
        try {
            if ((await fs.stat(candidatePath)).isFile()) return true;
        } catch { /* inaccessible targets do not resolve */ }
    }
    return false;
}
