/**
 * Unused export: an export the change adds that no other file names.
 *
 * Linters skip exports (no-unused-vars only sees module scope) and type checkers accept them, so
 * dead exports pile up in agent-written code. Only exports on added lines are checked. Another
 * file uses an export when it names the symbol as a whole word AND points at the module: an import,
 * re-export, dynamic import or mock whose specifier ends in the module's name (its folder's, for an
 * index file). A same-named word elsewhere, such as an unrelated route parameter, is not a use. What a framework calls by convention
 * (SvelteKit and Next.js route modules, hooks, serverless functions) is never reported.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { Config, Failure } from '../types/index.js';
import { emitsDeclarations, isPackageEntry } from './package-layout.js';

const GIT_TIMEOUT_MS = 10_000;
const CODE = /\.(ts|tsx|js|jsx|mjs|svelte)$/;
const SKIPPED = /\.(test|spec)\.|\.d\.ts$|(^|\/)(dist|build|out|coverage|\.next|[\w-]+-dist)\//;

/** What a route or hook module exports for its framework, not for an importer. */
const FRAMEWORK_EXPORTS = new Set([
    'load', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD', 'fallback', 'actions',
    'prerender', 'ssr', 'csr', 'trailingSlash', 'config', 'entries', 'handle', 'handleFetch',
    'handleError', 'reroute', 'transport', 'init', 'match', 'default',
    'metadata', 'generateMetadata', 'generateStaticParams', 'generateViewport', 'viewport',
    'dynamic', 'dynamicParams', 'revalidate', 'fetchCache', 'runtime', 'preferredRegion',
    'maxDuration', 'middleware', 'proxy',
]);

function isRouteModule(file: string): boolean {
    return /(^|\/)\+(page|layout|server|error)(\.server)?\.(ts|js)$/.test(file)
        || /(^|\/)hooks(\.server|\.client)?\.(ts|js)$/.test(file)
        || /(^|\/)params\/[^/]+\.(ts|js)$/.test(file)
        || /^netlify\/functions\//.test(file)
        || /(^|\/)(page|layout|route|loading|error|not-found|template|default|middleware|proxy)\.(ts|tsx|js|jsx)$/.test(file);
}

const DECLARATION = /^\s*export\s+(?:declare\s+)?(?:async\s+)?(const|let|var|function\*?|class|type|interface|enum|abstract\s+class)\s+([A-Za-z_$][\w$]*)/;
const LIST = /^\s*export\s+(?:type\s+)?\{([^}]*)\}\s*(?:;|$)/;
const RE_EXPORT = /^\s*export\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/;

interface AddedExport {
    file: string;
    name: string;
    line: number;
    /** For a re-export (`export { x } from './y'`): the module it comes from, which naming `x` does not make a use. */
    source?: string;
    /** Declared here as a type (type, interface): part of another export's signature in a project that emits declarations. */
    type?: boolean;
}

/** Exports on the diff's added lines, with their line in the new file. */
function addedExports(diff: string): AddedExport[] {
    const found: AddedExport[] = [];
    let file: string | undefined;
    let line = 0;
    let previous = '';
    for (const text of diff.split('\n')) {
        const header = text.startsWith('+++ ') && previous.startsWith('--- ');
        previous = text;
        if (header) {
            file = text.startsWith('+++ b/') ? text.slice('+++ b/'.length) : undefined;
            continue;
        }
        if (text.startsWith('diff --git ')) {
            file = undefined;
            continue;
        }
        const hunk = text.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
        if (hunk) {
            line = Number(hunk[1]);
            continue;
        }
        if (!file || text.startsWith('-')) continue;
        if (text.startsWith('+')) {
            if (CODE.test(file) && !SKIPPED.test(file)) found.push(...exportsOn(text.slice(1), file, line));
            line++;
        } else if (text.startsWith(' ')) {
            line++;
        }
    }
    return found;
}

function exportsOn(text: string, file: string, line: number): AddedExport[] {
    const declaration = text.match(DECLARATION);
    if (declaration) return [{ file, name: declaration[2], line, ...(/^(type|interface)$/.test(declaration[1]) ? { type: true } : {}) }];
    const reExport = text.match(RE_EXPORT);
    if (reExport) {
        const source = reExport[2].startsWith('.') ? path.posix.join(path.posix.dirname(file), reExport[2]) : undefined;
        return source ? names(reExport[1]).map(name => ({ file, name, line, source })) : []; // a package's export is that package's to judge
    }
    const list = text.match(LIST);
    if (!list || /\bfrom\b/.test(text)) return [];
    return names(list[1]).map(name => ({ file, name, line }));
}

/** The exported names in `a, b as c, type D`: what importers would write. */
function names(list: string): string[] {
    return list.split(',')
        .map(part => part.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop()?.trim())
        .filter((name): name is string => !!name && /^[A-Za-z_$][\w$]*$/.test(name));
}

const withoutExtension = (file: string) => path.posix.normalize(file).replace(/\.(ts|tsx|js|jsx|mjs|cjs|svelte)$/, '').replace(/\/index$/, '');

/** A file that names the export without using it: the exporting file itself, and a re-export's source module. */
function isOwnFile(user: string, exp: AddedExport): boolean {
    const normalized = path.posix.normalize(user);
    return normalized === path.posix.normalize(exp.file) || (!!exp.source && withoutExtension(normalized) === withoutExtension(exp.source));
}

export function unusedExportFailures(cwd: string, diff: string, config: Config): Failure[] {
    const settings = config.gates.unused_exports;
    if (!settings?.enabled) return [];
    const allowed = new Set(settings.allow);
    const candidates = addedExports(diff).filter(exp => !allowed.has(exp.name) && !(isRouteModule(exp.file) && FRAMEWORK_EXPORTS.has(exp.name))
        && !isPackageEntry(cwd, exp.file) && !signatureType(cwd, exp));
    if (candidates.length === 0) return [];
    const users = filesNaming(cwd, [...new Set(candidates.map(exp => exp.name))], ownOutputs(config));
    if (!users) return []; // git could not answer: say nothing rather than guess
    const points = pointsAtCache(cwd);
    return candidates
        .filter(exp => ![...(users.get(exp.name) ?? [])].some(user => !isOwnFile(user, exp) && points(user, exp.file)))
        .map(unused);
}

/**
 * In a project that emits declarations, an exported type named elsewhere in its own file is part
 * of another export's signature (TypeScript requires it to stay exported); in an application it is not.
 */
function signatureType(cwd: string, exp: AddedExport): boolean {
    if (!exp.type || !emitsDeclarations(cwd, exp.file)) return false;
    try {
        const pattern = new RegExp(`\\b${exp.name.replace(/\$/g, '\\$')}\\b`, 'g');
        return (fs.readFileSync(path.join(cwd, exp.file), 'utf8').match(pattern)?.length ?? 0) > 1;
    } catch {
        return false;
    }
}

/** Whether a file names `module` in a specifier: `from './dir/module'`, `import('../module.js')`, `vi.mock('$lib/module')`. */
function pointsAtCache(cwd: string): (file: string, module: string) => boolean {
    const texts = new Map<string, string>();
    return (file, module) => {
        const ext = path.posix.extname(module);
        const stem = path.posix.basename(module, ext);
        const names = stem === 'index' ? [path.posix.basename(path.posix.dirname(module)), 'index'] : [stem];
        const escaped = names.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
        const specifier = new RegExp(`['"\`][^'"\`]*/(?:${escaped})(\\.(ts|tsx|js|jsx|mjs|svelte))?['"\`]`);
        if (!texts.has(file)) {
            try {
                texts.set(file, fs.readFileSync(path.join(cwd, file), 'utf8'));
            } catch {
                texts.set(file, '');
            }
        }
        return specifier.test(texts.get(file)!);
    };
}

/** Rigour's own reports name exports and files; they must never count as a use. */
export function ownOutputs(config: Config): string[] {
    return ['.rigour', config.output?.report_path ?? 'rigour-report.json', 'rigour-fix-packet.json'];
}

/** Names per batch: one git grep over the repository answers them all. */
const NAMES_PER_SEARCH = 200;

/**
 * For each name, the tracked and new (untracked, not ignored) files containing it as a whole word,
 * Rigour's outputs aside: one `git grep -o` pass per batch of names instead of one per name.
 */
function filesNaming(cwd: string, names: string[], excluded: string[]): Map<string, Set<string>> | undefined {
    const found = new Map<string, Set<string>>();
    const pathspec = ['.', ...excluded.map(p => `:(exclude)${p}`)];
    for (let i = 0; i < names.length; i += NAMES_PER_SEARCH) {
        const patterns = names.slice(i, i + NAMES_PER_SEARCH).flatMap(name => ['-e', name]);
        const result = spawnSync('git', ['grep', '--untracked', '-z', '-o', '-w', '-F', ...patterns, '--', ...pathspec], { cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: 256 * 1024 * 1024 });
        if (result.status === 1) continue;
        if (result.status !== 0) return undefined;
        for (const line of result.stdout.split('\n')) {
            const [file, name] = line.split('\0');
            if (file && name) found.set(name, (found.get(name) ?? new Set()).add(file));
        }
    }
    return found;
}

function unused(exp: AddedExport): Failure {
    return {
        id: 'unused-export',
        title: 'Unused export',
        details: `\`${exp.name}\` is exported but no other file uses it. An export nothing imports is dead code that readers and agents treat as part of the module's contract.`,
        severity: 'medium',
        provenance: 'traditional',
        files: [exp.file],
        line: exp.line,
        hint: `Drop the \`export\` (or the declaration, if nothing in the file uses it either). If a framework or tool loads it by name, add \`${exp.name}\` to gates.unused_exports.allow.`,
    };
}
