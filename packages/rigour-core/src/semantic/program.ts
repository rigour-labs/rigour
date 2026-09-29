/**
 * TypeScript programs for semantic analysis.
 *
 * Compiler options come from the nearest tsconfig through the compiler's own
 * parser, so `extends` and `paths` behave as they do for tsc. Measured on a
 * 2,400-file Next.js repo: a program for a few scoped files builds in ~0.5s;
 * a full scan, in batches and with external packages left unresolved, runs in
 * ~14s at ~1.3GB RSS (it was ~29s and ~2.8GB with package types loaded).
 */
import path from 'path';
import ts from 'typescript';

export const DEFAULT_BATCH_SIZE = 200;

export interface ProjectConfig {
    options: ts.CompilerOptions;
    /** Every source file the tsconfig includes; empty without a tsconfig. */
    fileNames: string[];
}

export function loadProjectConfig(cwd: string): ProjectConfig {
    const configPath = ts.findConfigFile(cwd, ts.sys.fileExists, 'tsconfig.json');
    const base: ts.CompilerOptions = { allowJs: true, checkJs: false };
    if (!configPath || !path.resolve(configPath).startsWith(path.resolve(cwd))) {
        return { options: analysisOptions(base), fileNames: [] };
    }
    const read = ts.readConfigFile(configPath, ts.sys.readFile);
    if (read.error) return { options: analysisOptions(base), fileNames: [] };
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(configPath));
    return { options: analysisOptions({ ...base, ...parsed.options }), fileNames: parsed.fileNames };
}

/** Options for analysis only: nothing is emitted and lib files are not checked. */
function analysisOptions(options: ts.CompilerOptions): ts.CompilerOptions {
    return { ...options, noEmit: true, skipLibCheck: true, types: [], incremental: false, composite: false };
}

/**
 * A compiler host that resolves project modules but not external packages.
 * The rules need project functions (relative and `paths` imports) and the
 * built-in lib globals (`fetch`, `Promise`, `Response`), not the .d.ts graph
 * behind next, react or a database client. Without this, one batch of a
 * 2,400-file repo pulls in that whole graph (~2.7GB RSS whatever the batch
 * size); with it, memory follows the project's own code.
 */
function projectOnlyHost(options: ts.CompilerOptions): ts.CompilerHost {
    const host = ts.createCompilerHost(options);
    host.resolveModuleNameLiterals = (literals, containingFile, _redirect, opts) => literals.map(literal => {
        const resolved = ts.resolveModuleName(literal.text, containingFile, opts, host).resolvedModule;
        return { resolvedModule: resolved && !resolved.isExternalLibraryImport ? resolved : undefined };
    });
    return host;
}

/**
 * Programs over `rootFiles` in batches. Each batch reuses the previous
 * program's unchanged source files, and only one program is alive at a time.
 */
export function* programBatches(
    rootFiles: string[],
    options: ts.CompilerOptions,
    batchSize = DEFAULT_BATCH_SIZE,
): Generator<ts.Program> {
    const host = projectOnlyHost(options);
    let previous: ts.Program | undefined;
    for (let i = 0; i < rootFiles.length; i += batchSize) {
        const program: ts.Program = ts.createProgram({
            rootNames: rootFiles.slice(i, i + batchSize),
            options,
            host,
            oldProgram: previous,
        });
        previous = program;
        yield program;
    }
}
