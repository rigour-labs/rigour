/**
 * Where the local embedding library (`@xenova/transformers`, with its ONNX runtime about 230 MB)
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
export const TRANSFORMERS_SPEC = '@xenova/transformers@2.17.2';
const PACKAGE = '@xenova/transformers';

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
    return fs.existsSync(path.join(semanticRuntimeDir(), 'node_modules', ...PACKAGE.split('/'), 'package.json'));
}
