/**
 * The project's TypeScript program, built once per review from its own tsconfig.json and its own
 * `typescript` (the compiler version and options then match what the project type-checks with;
 * Rigour's bundled compiler is the fallback). What the type checker knows (which literal is typed
 * as T, which property is read where) is what the typed checks reason from. Files outside the
 * program (.svelte, a package under its own tsconfig) are kept as text and scanned by name only,
 * which can suppress a finding and never adds one.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import { createRequire } from 'module';
import path from 'path';
import ownTs from 'typescript';
import type * as TS from 'typescript';
import { installedBin } from '../../utils/installed-bin.js';

export interface TextFile { file: string; text: string }

export interface TypedProgram {
    ts: typeof TS;
    program: TS.Program;
    checker: TS.TypeChecker;
    root: string;
    /** A source file's path relative to the root, posix. */
    rel(sf: TS.SourceFile): string;
    /** The sources (outside node_modules, no declaration files) that are not tests: where a host or a reader counts. */
    appSources: TS.SourceFile[];
    /** Files the program does not type, as text. */
    textFiles: TextFile[];
    inProgram: Set<string>;
}

export const TEST_FILE = /\.(test|spec|e2e)\.[cm]?[jt]sx?$|(^|\/)(tests?|e2e|__tests__|__mocks__)\//;
const GIT_TIMEOUT_MS = 10_000;

/** The program, `skip` when this is not a TypeScript project, or `error` when it is one that cannot be loaded. */
export function loadProgram(root: string): { program: TypedProgram } | { skip: string } | { error: string } {
    const tsconfig = path.join(root, 'tsconfig.json');
    if (!fs.existsSync(tsconfig)) return { skip: 'no tsconfig.json' };
    const ts = projectTypescript(root);
    let parsed = parseConfig(ts, tsconfig);
    if ('error' in parsed && /\.svelte-kit\//.test(parsed.error) && syncSvelteKit(root)) parsed = parseConfig(ts, tsconfig);
    if ('error' in parsed) return { error: `tsconfig.json cannot be loaded: ${parsed.error}` };
    const program = ts.createProgram({ rootNames: parsed.config.fileNames, options: { ...parsed.config.options, noEmit: true } });
    const rel = (sf: TS.SourceFile) => path.relative(root, sf.fileName).split(path.sep).join('/');
    const sources = program.getSourceFiles().filter(sf => !sf.isDeclarationFile && !sf.fileName.includes('/node_modules/'));
    const inProgram = new Set(sources.map(rel));
    return {
        program: {
            ts, program, checker: program.getTypeChecker(), root, rel,
            appSources: sources.filter(sf => !TEST_FILE.test(rel(sf))),
            textFiles: textFiles(root, inProgram),
            inProgram,
        },
    };
}

function projectTypescript(root: string): typeof TS {
    try {
        return createRequire(path.join(root, 'package.json'))('typescript') as typeof TS;
    } catch {
        return ownTs as unknown as typeof TS;
    }
}

function parseConfig(ts: typeof TS, tsconfig: string): { config: TS.ParsedCommandLine } | { error: string } {
    try {
        const config = ts.getParsedCommandLineOfConfigFile(tsconfig, {}, {
            ...ts.sys,
            onUnRecoverableConfigFileDiagnostic: diagnostic => {
                throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
            },
        });
        if (!config) return { error: 'unreadable' };
        // A missing `extends` target or an unknown option is a diagnostic, not an exception; tsc would fail on it too.
        const errors = config.errors.filter(d => d.category === ts.DiagnosticCategory.Error).map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
        return errors.length ? { error: errors.join('; ') } : { config };
    } catch (error: any) {
        return { error: String(error.message ?? error) };
    }
}

/** A SvelteKit tsconfig extends a generated one; `svelte-kit sync` writes it (never downloaded: the project's own binary or nothing). */
function syncSvelteKit(root: string): boolean {
    const bin = installedBin(root, root, 'svelte-kit');
    if (!bin) return false;
    return spawnSync(bin, ['sync'], { cwd: root, stdio: 'ignore', timeout: 120_000 }).status === 0;
}

function textFiles(root: string, inProgram: Set<string>): TextFile[] {
    const listed = spawnSync('git', ['ls-files', '--', '*.svelte', '*.ts', '*.js'], { cwd: root, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
    if (listed.status !== 0) return [];
    const files: TextFile[] = [];
    for (const file of listed.stdout.split('\n')) {
        if (!file || inProgram.has(file) || file.endsWith('.d.ts') || TEST_FILE.test(file)) continue;
        try {
            files.push({ file, text: fs.readFileSync(path.join(root, file), 'utf8') });
        } catch {
            // deleted in the working tree
        }
    }
    return files;
}
