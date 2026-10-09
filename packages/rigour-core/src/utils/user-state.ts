import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * The home Rigour keeps its state under (`<home>/.rigour`): RIGOUR_HOME when set (a profile, a sandbox, tests),
 * else the OS home. A RIGOUR_HOME ending in `.rigour` names the state directory itself, so its parent is the home.
 * Earlier versions kept state one level deeper (`<RIGOUR_HOME>/.rigour`): where that holds state, it stays in use
 * and nothing is moved (legacyStateNote says how).
 */
export function rigourHome(): string {
    const set = process.env.RIGOUR_HOME;
    if (!set) return os.homedir();
    if (path.basename(path.resolve(set)) !== '.rigour') return set;
    return hasState(path.join(set, '.rigour')) ? set : path.dirname(path.resolve(set));
}

function hasState(dir: string): boolean {
    try {
        return fs.readdirSync(dir).length > 0;
    } catch {
        return false;
    }
}

/**
 * For `rigour doctor`: state an earlier version wrote under `<RIGOUR_HOME>/.rigour`, still in use, and how to move
 * it; or, when the named directory holds state of its own too, both places. Nothing is moved for anyone.
 */
export function legacyStateNote(): string | undefined {
    const set = process.env.RIGOUR_HOME;
    if (!set || path.basename(path.resolve(set)) !== '.rigour') return undefined;
    const named = path.resolve(set);
    const doubled = path.join(named, '.rigour');
    if (!hasState(doubled)) return undefined;
    const own = (() => { try { return fs.readdirSync(named).filter(entry => entry !== '.rigour').length > 0; } catch { return false; } })();
    return own
        ? `Rigour state is in both ${named} and ${doubled}. This run uses ${doubled}, where your tools have been writing; merge the two by hand if you need both.`
        : `Rigour state is in ${doubled}, written by an earlier version. RIGOUR_HOME=${set} now names the state directory itself: to use ${named}, move the contents of ${doubled} up one level.`;
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
