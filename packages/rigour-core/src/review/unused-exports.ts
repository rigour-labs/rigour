/**
 * Unused export: an export the change adds that no other file names.
 *
 * Linters skip exports (no-unused-vars only sees module scope) and type checkers accept them, so
 * dead exports pile up in agent-written code. Only exports on added lines are checked. A name
 * counts as used when any other tracked or new file contains it as a whole word, so the check errs
 * toward missing dead code rather than flagging live code. What a framework calls by convention
 * (SvelteKit and Next.js route modules, hooks, serverless functions) is never reported.
 */
import { spawnSync } from 'child_process';
import path from 'path';
import type { Config, Failure } from '../types/index.js';

const GIT_TIMEOUT_MS = 10_000;
const CODE = /\.(ts|tsx|js|jsx|mjs|svelte)$/;
const SKIPPED = /\.(test|spec)\.|\.d\.ts$/;

/** What a route or hook module exports for its framework, not for an importer. */
const FRAMEWORK_EXPORTS = new Set([
    'load', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD', 'fallback', 'actions',
    'prerender', 'ssr', 'csr', 'trailingSlash', 'config', 'entries', 'handle', 'handleFetch',
    'handleError', 'reroute', 'transport', 'init', 'match', 'default',
    'metadata', 'generateMetadata', 'generateStaticParams', 'generateViewport', 'viewport',
    'dynamic', 'dynamicParams', 'revalidate', 'fetchCache', 'runtime', 'preferredRegion',
    'maxDuration', 'middleware', 'proxy',
]);

export function isRouteModule(file: string): boolean {
    return /(^|\/)\+(page|layout|server|error)(\.server)?\.(ts|js)$/.test(file)
        || /(^|\/)hooks(\.server|\.client)?\.(ts|js)$/.test(file)
        || /(^|\/)params\/[^/]+\.(ts|js)$/.test(file)
        || /^netlify\/functions\//.test(file)
        || /(^|\/)(page|layout|route|loading|error|not-found|template|default|middleware|proxy)\.(ts|tsx|js|jsx)$/.test(file);
}

const DECLARATION = /^\s*export\s+(?:declare\s+)?(?:async\s+)?(?:const|let|var|function\*?|class|type|interface|enum|abstract\s+class)\s+([A-Za-z_$][\w$]*)/;
const LIST = /^\s*export\s+(?:type\s+)?\{([^}]*)\}\s*(?:;|$)/;

export interface AddedExport {
    file: string;
    name: string;
    line: number;
}

/** Exports on the diff's added lines, with their line in the new file. */
export function addedExports(diff: string): AddedExport[] {
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
    if (declaration) return [{ file, name: declaration[1], line }];
    const list = text.match(LIST);
    if (!list || /\bfrom\b/.test(text)) return [];
    return list[1].split(',')
        .map(part => part.trim().split(/\s+as\s+/).pop()?.trim())
        .filter((name): name is string => !!name && /^[A-Za-z_$][\w$]*$/.test(name))
        .map(name => ({ file, name, line }));
}

export function unusedExportFailures(cwd: string, diff: string, config: Config): Failure[] {
    const settings = config.gates.unused_exports;
    if (!settings?.enabled) return [];
    const allowed = new Set(settings.allow);
    const failures: Failure[] = [];
    for (const exp of addedExports(diff)) {
        if (allowed.has(exp.name) || (isRouteModule(exp.file) && FRAMEWORK_EXPORTS.has(exp.name))) continue;
        const users = filesNaming(cwd, exp.name, ownOutputs(config));
        if (users === undefined) continue; // git could not answer: say nothing rather than guess
        if (users.some(user => path.posix.normalize(user) !== path.posix.normalize(exp.file))) continue;
        failures.push(unused(exp));
    }
    return failures;
}

/** Rigour's own reports name exports and files; they must never count as a use. */
export function ownOutputs(config: Config): string[] {
    return ['.rigour', config.output?.report_path ?? 'rigour-report.json', 'rigour-fix-packet.json'];
}

/** Tracked and new (untracked, not ignored) files containing `name` as a whole word, Rigour's outputs aside. */
function filesNaming(cwd: string, name: string, excluded: string[]): string[] | undefined {
    const pathspec = ['.', ...excluded.map(p => `:(exclude)${p}`)];
    const result = spawnSync('git', ['grep', '--untracked', '-l', '-w', '-F', '-e', name, '--', ...pathspec], { cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
    if (result.status === 1) return [];
    if (result.status !== 0) return undefined;
    return result.stdout.split('\n').filter(Boolean);
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
