/**
 * Orphaned file: a code file the change adds that nothing imports or runs.
 *
 * An agent that tries one approach, then another, leaves the first behind; type checkers and
 * linters only look inside files, so a whole unused module passes them. A reference is a path
 * named in code, package.json, CI or config (docs only mention), resolved to a file: relative
 * paths against the naming file, `$lib/` to `src/lib/`, anything else from the repository root
 * as npm scripts and CI write them. A common basename elsewhere never keeps a file alive, and a
 * folder of new files that only import each other is reported as a whole. Files a framework or
 * runner finds by itself (routes, hooks, tests, migrations, config) are never reported.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import micromatch from 'micromatch';
import type { Config, Failure } from '../types/index.js';
import { addedFiles } from './migration-order.js';
import { sourceStem } from './package-layout.js';
import { ownOutputs } from './unused-exports.js';
import { isTestFile } from './test-files.js';

const GIT_TIMEOUT_MS = 10_000;
const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|svelte)$/;
const FOUND_BY_RUNNER = /(^|\/)\+[^/]+$|(^|\/)hooks(\.server|\.client)?\.(ts|js)$|^netlify\/functions\/|^src\/params\/|\.d\.ts$|^(migrations|supabase)\/|\.config\.[a-z]+$|^\./;
/** Files that can run or import another: code, package.json, CI and config. */
const REFERRER = /\.(ts|tsx|js|jsx|mjs|cjs|svelte|json|ya?ml|toml|sh)$/;
/** Lockfiles and generated bundles name no source file and can be megabytes. */
const MAX_REFERRER_BYTES = 2 * 1024 * 1024;
const SPECIFIER = /['"`\s]((?:\.{1,2}\/|\$lib\/|[\w@-]+\/)[^'"`\s]*)/g;

/** A module as importers name it: `x.svelte.ts` is imported as `./x.svelte` or `./x.svelte.js`, `dir/index.ts` as `dir`. */
const withoutExtension = (file: string) => file.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, '').replace(/\.svelte$/, '').replace(/\/index$/, '');
/** Build output committed to the repository: bundles, not sources anyone imports. */
const BUILD_OUTPUT = /(^|\/)(dist|build|out|coverage|\.next|[\w-]+-dist)\//;

export function orphanFileFailures(cwd: string, diff: string, config: Config): Failure[] {
    const settings = config.gates.orphan_files;
    if (!settings?.enabled) return [];
    const added = addedFiles(diff).filter(file => CODE.test(file) && !FOUND_BY_RUNNER.test(file) && !isTestFile(file) && !BUILD_OUTPUT.test(file) && !micromatch.isMatch(file, settings.allow));
    if (added.length === 0) return [];
    const excluded = ownOutputs(config);
    const files = repositoryFiles(cwd)?.filter(file => !excluded.some(own => file === own || file.startsWith(`${own}/`)));
    if (!files) return []; // git could not answer: say nothing rather than guess
    const referrers = referrersOf(cwd, added, files);
    return [...unreferenced(added, referrers)].map(file => orphan(file, !settings.block));
}

/** Tracked and new (untracked, not ignored) files. */
function repositoryFiles(cwd: string): string[] | undefined {
    const result = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
    return result.status === 0 ? [...new Set(result.stdout.split('\n').filter(Boolean))] : undefined;
}

/** For each added file, the files that name it. */
function referrersOf(cwd: string, added: string[], files: string[]): Map<string, Set<string>> {
    const targets = new Map(added.map(file => [withoutExtension(path.posix.normalize(file)), file]));
    const underFolder = new Map<string, string[]>();
    for (const file of added) {
        for (let dir = path.posix.dirname(file); dir !== '.' && dir !== '/'; dir = path.posix.dirname(dir)) {
            const files = underFolder.get(dir);
            if (files) files.push(file);
            else underFolder.set(dir, [file]);
        }
    }
    const referrers = new Map(added.map(file => [file, new Set<string>()]));
    for (const referrer of files) {
        if (!REFERRER.test(referrer)) continue;
        let text: string;
        try {
            if (fs.statSync(path.join(cwd, referrer)).size > MAX_REFERRER_BYTES) continue;
            text = fs.readFileSync(path.join(cwd, referrer), 'utf8');
        } catch {
            continue; // deleted in the working tree
        }
        for (const [, specifier] of text.matchAll(SPECIFIER)) {
            for (const candidate of resolve(referrer, specifier)) {
                const named = withoutExtension(path.posix.normalize(candidate)).replace(/\/+$/, '');
                const target = targets.get(named);
                if (target && target !== referrer) referrers.get(target)!.add(referrer);
                // A folder named in code (a fixtures or plugins directory read at run time) reaches every file under it.
                for (const file of underFolder.get(named) ?? []) if (file !== referrer) referrers.get(file)!.add(referrer);
            }
        }
    }
    return referrers;
}

/**
 * The files a specifier can name: relative to the naming file; `$lib/` as `src/lib/`; any other
 * path from the repository root (as npm scripts and CI write them) and from the naming file's
 * folder (a package.json in a subfolder); a compiled path (`dist/bin.js`) as its source.
 */
function resolve(referrer: string, specifier: string): string[] {
    if (specifier.startsWith('.')) return [path.posix.join(path.posix.dirname(referrer), specifier)];
    if (specifier.startsWith('$lib/')) return [`src/lib/${specifier.slice('$lib/'.length)}`];
    const fromFolder = path.posix.join(path.posix.dirname(referrer), specifier);
    return [specifier, fromFolder, sourceStem(specifier), path.posix.join(path.posix.dirname(referrer), sourceStem(specifier))];
}

/** Added files nothing outside the added set reaches, found by clearing suspects until nothing changes. */
function unreferenced(added: string[], referrers: Map<string, Set<string>>): Set<string> {
    const suspects = new Set(added);
    for (let cleared = true; cleared;) {
        cleared = false;
        for (const file of suspects) {
            if ([...referrers.get(file)!].some(referrer => !suspects.has(referrer))) {
                suspects.delete(file);
                cleared = true;
            }
        }
    }
    return suspects;
}

function orphan(file: string, advisory: boolean): Failure {
    return {
        id: 'orphan-file',
        ...(advisory ? { advisory } : {}),
        title: 'Orphaned file',
        details: `\`${file}\` is new, but nothing outside the change's new files imports or runs it.`,
        severity: 'medium',
        provenance: 'traditional',
        files: [file],
        line: 1,
        hint: 'Delete it, or wire it in where it is meant to run. If a tool loads it by path, add it to gates.orphan_files.allow.',
    };
}
