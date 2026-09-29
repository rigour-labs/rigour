/**
 * Signals for `rigour init` discovery.
 *
 * Substring search misread projects: "reactivity" in an ESLint comment made
 * a Svelte repo "react", and "the public internet" in a Playwright comment
 * made it "OOP". Framework markers now match package.json dependency names,
 * other markers match whole tokens, and the paradigm comes from counting
 * declarations in real source files, with no guess when neither side leads.
 */
import fs from 'fs-extra';
import path from 'path';
import { globby } from 'globby';

const SOURCE_EXT = '{ts,tsx,js,jsx,mjs,py,go,java,kt,rb}';
const SOURCE_GLOBS = [
    `{src,lib,app,pkg,api,internal,cmd}/**/*.${SOURCE_EXT}`,
    `{packages,apps,services}/*/{src,lib,app}/**/*.${SOURCE_EXT}`,
    '*.{py,go}',
];
const SOURCE_IGNORE = ['**/node_modules/**', '**/dist/**', '**/build/**', '**/*.d.ts', '**/*.config.*', '**/*.{test,spec}.*', '**/__tests__/**'];
const MAX_SAMPLE = 40;

/**
 * Framework and library markers. These are decided by the project's declared
 * dependencies only: as words they are too common in code and prose
 * ("next()" in Express middleware, "reactivity" in a Svelte comment).
 */
export const PACKAGE_MARKERS = new Set(['react', 'next', 'vue', 'svelte', 'express', 'fastify', 'nestjs', 'spark', 'pandas']);

/** Declared dependency names: package.json sections, requirements.txt and pyproject.toml. */
export async function dependencyNames(cwd: string): Promise<Set<string>> {
    const names = new Set<string>();
    const pkg = await fs.readJson(path.join(cwd, 'package.json')).catch(() => null);
    for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
        for (const name of Object.keys(pkg?.[section] ?? {})) names.add(name);
    }
    const requirements = await fs.readFile(path.join(cwd, 'requirements.txt'), 'utf-8').catch(() => '');
    for (const match of requirements.matchAll(/^\s*([A-Za-z0-9][\w.-]*)/gm)) names.add(match[1].toLowerCase());
    const pyproject = await fs.readFile(path.join(cwd, 'pyproject.toml'), 'utf-8').catch(() => '');
    for (const match of pyproject.matchAll(/["']([A-Za-z0-9][\w.-]*)\s*(?:\[[^\]]*\])?\s*(?:[<>=~!;]|["'])/g)) names.add(match[1].toLowerCase());
    return names;
}

/** `marker` is declared as a dependency, directly or as its scope (`@nestjs/core`). */
export function declaresPackage(dependencies: Set<string>, marker: string): boolean {
    if (dependencies.has(marker)) return true;
    for (const name of dependencies) if (name.startsWith(`@${marker}/`)) return true;
    return false;
}

/** Up to MAX_SAMPLE project source files (not configs or tests), spread evenly so one package cannot fill the sample. */
export async function sampleSourceFiles(cwd: string): Promise<string[]> {
    const files = (await globby(SOURCE_GLOBS, { cwd, ignore: SOURCE_IGNORE, gitignore: false, followSymbolicLinks: false })).sort();
    const stride = Math.max(1, files.length / MAX_SAMPLE);
    const sample: string[] = [];
    for (let i = 0; i < files.length && sample.length < MAX_SAMPLE; i += stride) sample.push(files[Math.floor(i)]);
    return sample.map(f => path.join(cwd, f));
}

/** Markers naming a file extension (`ipynb`): proven by one such file existing, not by the word. */
export const EXTENSION_MARKERS = new Set(['ipynb']);

export async function hasFileWithExtension(cwd: string, extension: string): Promise<boolean> {
    const found = await globby(`**/*.${extension}`, { cwd, ignore: ['**/node_modules/**', '**/.git/**'], gitignore: false, followSymbolicLinks: false, deep: 4 });
    return found.length > 0;
}

/** A marker naming a file or folder (`next.config.js`, `k8s/`, `Dockerfile`), which only its existence proves. */
export function isPathMarker(marker: string): boolean {
    return /[./]/.test(marker) || /^[A-Z]/.test(marker);
}

/** `marker` as a whole token, not inside a longer word or package name. */
export function containsToken(text: string, marker: string): boolean {
    const escaped = marker.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![\\w@/.-])${escaped}(?![\\w-])`, 'i').test(text);
}

/** Drop line and block comments so prose is not read as code. */
export function stripComments(text: string): string {
    return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'`])\/\/.*$/gm, '$1').replace(/^\s*#.*$/gm, '');
}

const CLASS_DECLARATION = /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:public\s+)?class\s+[A-Z]\w*/gm;
const FUNCTION_DECLARATION = /^\s*(?:export\s+(?:default\s+)?(?:async\s+)?function\b|export\s+const\s+\w+\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*(?::[^=]+)?=>|def\s+\w+\s*\(|func\s+\w+\s*\()/gm;

export interface ParadigmSignal {
    name: 'oop' | 'functional';
    marker: string;
}

/** OOP or functional by declaration counts in comment-free sources; null when neither clearly dominates. */
export function detectParadigm(contents: string[]): ParadigmSignal | null {
    let classes = 0;
    let functions = 0;
    for (const text of contents) {
        classes += text.match(CLASS_DECLARATION)?.length ?? 0;
        functions += text.match(FUNCTION_DECLARATION)?.length ?? 0;
    }
    const marker = `declarations: ${classes} classes, ${functions} functions`;
    if (classes > 0 && classes >= 2 * functions) return { name: 'oop', marker };
    if (functions > 0 && functions >= 2 * classes) return { name: 'functional', marker };
    return null;
}
