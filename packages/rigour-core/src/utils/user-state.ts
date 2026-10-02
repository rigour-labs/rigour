import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

/** The user's Rigour directory: RIGOUR_HOME/.rigour when set (tests, sandboxes), else ~/.rigour. */
export function rigourUserDir(): string {
    return path.join(process.env.RIGOUR_HOME || os.homedir(), '.rigour');
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
