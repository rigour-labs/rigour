import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

/** The home Rigour keeps its state under: RIGOUR_HOME when set (a profile, a sandbox, tests), else the OS home. */
export function rigourHome(): string {
    return process.env.RIGOUR_HOME || os.homedir();
}

/** The user's Rigour directory: `<rigourHome()>/.rigour`. Every piece of Rigour's own state lives under it. */
export function rigourUserDir(): string {
    return path.join(rigourHome(), '.rigour');
}

/**
 * Per-repository state kept outside the workspace, where an agent editing the repository
 * cannot rewrite it: arbitration tokens, stop-hook attempt counts. Keyed by the real path.
 */
export function repoStateDir(cwd: string): string {
    let root = path.resolve(cwd);
    try { root = fs.realpathSync.native(root); } catch { /* not created yet: the resolved path is the key */ }
    const key = crypto.createHash('sha256').update(root).digest('hex').slice(0, 16);
    return path.join(rigourUserDir(), 'repos', key);
}
