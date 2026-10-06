/**
 * After a merge from main: which main-side files the branch's changed files import, and how main
 * changed them. A branch call site written against the old definition is the regression a plain
 * diff review never shows (main changes how an id is parsed; the branch's link builder keeps
 * building the old shape). Rendered as Markdown for the reviewer; empty when nothing overlaps.
 */
import path from 'path';
import { GH_TIMEOUT_MS, type Exec } from './exec.js';

const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|svelte)$/;
const TEST = /\.(test|spec|e2e)\.[cm]?[jt]sx?$/;
const IMPORT = /import\s*(?:type\s*)?(?:\{([^}]*)\}|(\w+))?\s*(?:,\s*\{([^}]*)\})?\s*from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
const MAX_DIFF_CHARS = 12_000;

const withoutExtension = (file: string) => file.replace(CODE, '').replace(/\/index$/, '');

export async function mergeImpact(cwd: string, oldBase: string, newBase: string, head: string, exec: Exec): Promise<string> {
    const git = async (args: string[]) => (await exec('git', args, { cwd, timeoutMs: GH_TIMEOUT_MS })).stdout;
    const files = (text: string) => text.split('\n').filter(f => f && CODE.test(f));
    const mainSide = new Set(files(await git(['diff', '--name-only', oldBase, newBase])));
    const branchFiles = files(await git(['diff', '--name-only', `${newBase}...${head}`]));
    // A file both sides changed was reconciled by the merge itself; the silent risk is a
    // main-only change under a branch file that still calls the old shape.
    for (const file of branchFiles) mainSide.delete(file);
    const mainByStem = new Map([...mainSide].map(file => [withoutExtension(file), file]));
    const hits: Array<{ file: string; mainFile: string; names: string[] }> = [];
    for (const file of branchFiles) {
        if (TEST.test(file)) continue;
        const shown = await exec('git', ['show', `${head}:${file}`], { cwd, timeoutMs: GH_TIMEOUT_MS });
        if (shown.exitCode !== 0) continue;
        for (const match of shown.stdout.matchAll(IMPORT)) {
            const target = resolve(match[4] ?? match[5], file);
            const mainFile = target ? mainByStem.get(target) : undefined;
            if (!mainFile) continue;
            const names = [match[1], match[3]].filter(Boolean).join(',').split(',').map(s => s.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]).filter(Boolean);
            if (match[2]) names.push(match[2]);
            hits.push({ file, mainFile, names });
        }
    }
    if (hits.length === 0) return '';
    const out = ['## Merge impact: main-side files the branch imports that main changed', ''];
    const seen = new Set<string>();
    for (const hit of hits) {
        if (seen.has(`${hit.file}|${hit.mainFile}`)) continue;
        seen.add(`${hit.file}|${hit.mainFile}`);
        const named = hit.names.join(', ') || '(default)';
        out.push(`### ${hit.file} imports ${named} from ${hit.mainFile}`);
        const tests = [...mainSide].filter(f => f !== hit.mainFile && f.replace(/\.(test|spec)\./, '.') === hit.mainFile);
        const diff = await git(['diff', '--unified=3', oldBase, newBase, '--', hit.mainFile, ...tests]);
        out.push('```diff', diff.trim().slice(0, MAX_DIFF_CHARS), '```', '', `Check every call site of ${named} in ${hit.file} against the new definition and the new tests.`, '');
    }
    return out.join('\n');
}

function resolve(specifier: string, from: string): string | undefined {
    if (specifier.startsWith('.')) return withoutExtension(path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier)));
    if (specifier.startsWith('$lib/')) return withoutExtension(`src/lib/${specifier.slice(5)}`);
    return undefined;
}
