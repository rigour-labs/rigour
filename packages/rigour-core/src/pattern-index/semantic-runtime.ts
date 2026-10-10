/**
 * Where the local embedding library (`@huggingface/transformers` and its ONNX runtime)
 * comes from. It is not a dependency of the npm package: npm installed it again for every
 * version a hook pinned, so a machine kept one copy per Rigour version. `rigour setup` installs it
 * once into Rigour's home, where every version finds it.
 *
 * Search order: next to Rigour itself (a checkout, or a project that installs Rigour and the
 * library as devDependencies), the project being worked on, then Rigour's home. Without it,
 * recall and pattern matching fall back to keywords, which find far less (on the committed eval
 * sets, 6% of memories and 20% of existing helpers, against 81% and 93% by meaning).
 */
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { rigourUserDir } from '../utils/user-state.js';

/** The version installed by `rigour setup`; the model it loads is fetched once on first use. */
export const TRANSFORMERS_SPEC = '@huggingface/transformers@4.3.1';
const PACKAGE = '@huggingface/transformers';
/** What `rigour setup` installed up to 6.x: never loaded now (its image library has known vulnerabilities). */
export const RETIRED_TRANSFORMERS_PACKAGE = '@xenova/transformers';

/**
 * The environment for installing it. The ONNX runtime's install step downloads its CUDA provider on Linux (about
 * 260 MB); Rigour embeds on the CPU, so it is never loaded.
 */
export const SEMANTIC_INSTALL_ENV = { ONNXRUNTIME_NODE_INSTALL: 'skip' } as const;

/**
 * Removes the ONNX runtime's binaries for other platforms and architectures from an install (`<dir>/node_modules`):
 * the package ships every one (200 to 240 MB) and loads only `bin/napi-v*\/<platform>/<arch>`. Returns the bytes freed.
 */
export function pruneSemanticRuntime(dir: string, platform: string = process.platform, arch: string = process.arch): number {
    let freed = 0;
    const remove = (target: string) => {
        freed += sizeOf(target);
        fs.rmSync(target, { recursive: true, force: true });
    };
    const bin = path.join(dir, 'node_modules', 'onnxruntime-node', 'bin');
    for (const napi of children(bin)) {
        for (const os of children(napi)) {
            if (path.basename(os) !== platform) remove(os);
            else for (const cpu of children(os)) if (path.basename(cpu) !== arch) remove(cpu);
        }
    }
    return freed;
}

function children(dir: string): string[] {
    try {
        return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => path.join(dir, e.name));
    } catch {
        return [];
    }
}

function sizeOf(target: string): number {
    const stat = fs.lstatSync(target);
    if (!stat.isDirectory()) return stat.size;
    return fs.readdirSync(target).reduce((sum, name) => sum + sizeOf(path.join(target, name)), 0);
}

/** Rigour's own copy, shared by every Rigour version on the machine (per profile home). */
export function semanticRuntimeDir(): string {
    return path.join(rigourUserDir(), 'runtime', 'semantic');
}

/** Where the library resolves from, or undefined when it is not installed anywhere Rigour looks. */
export function locateTransformers(cwd = process.cwd()): string | undefined {
    for (const base of [import.meta.url, path.join(cwd, 'package.json'), path.join(semanticRuntimeDir(), 'package.json')]) {
        try {
            return createRequire(base).resolve(PACKAGE);
        } catch {
            // not there
        }
    }
    return undefined;
}

/** The library's module, loaded from wherever it is installed. */
export async function loadTransformers(cwd = process.cwd()): Promise<any | undefined> {
    const entry = locateTransformers(cwd);
    if (!entry) return undefined;
    return import(pathToFileURL(entry).href);
}

/** Whether Rigour's home has its own copy (what `rigour setup` installs). */
export function semanticRuntimeInstalled(): boolean {
    return installedInRuntime(PACKAGE);
}

/** Whether Rigour's home still has the library an earlier `rigour setup` installed, which this version does not load. */
export function retiredSemanticRuntimeInstalled(): boolean {
    return installedInRuntime(RETIRED_TRANSFORMERS_PACKAGE);
}

function installedInRuntime(name: string): boolean {
    return fs.existsSync(path.join(semanticRuntimeDir(), 'node_modules', ...name.split('/'), 'package.json'));
}
