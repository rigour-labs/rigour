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
    return homeFor(process.env.RIGOUR_HOME);
}

/** The home a RIGOUR_HOME (or a profile's home) of `set` resolves to, by the rule above; the OS home when unset. */
export function homeFor(set: string | undefined): string {
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
        ? `Rigour state is in both ${named} and ${doubled}: a home ending in .rigour from before 6.11.1. ${doubled} is the live state, and this run uses it; ${named} holds what was left over. Merge the leftovers in, losing neither: rigour doctor --merge-state`
        : `Rigour state is in ${doubled}, written by an earlier version. RIGOUR_HOME=${set} now names the state directory itself: to use ${named}, move the contents of ${doubled} up one level.`;
}

/** One step of `rigour doctor --merge-state`: what happens to an entry the outer directory still holds. */
export interface StateMergeStep {
    /** `move`: the live directory has no such entry, so it moves in. `aside`: the live one is kept, and the outer one renamed beside it. */
    action: 'move' | 'aside';
    from: string;
    to: string;
}

/**
 * The leftovers of a home ending in .rigour from before 6.11.1, merged into the live (nested) state directory: an entry
 * the live directory lacks moves in; one both hold stays live, and the outer one is renamed `<name>.merged-<date>` where
 * it is; directories both hold are merged entry by entry. Nothing is deleted or overwritten. Undefined when there is
 * nothing to merge.
 */
export function planStateMerge(date = new Date().toISOString().slice(0, 10)): { outer: string; live: string; steps: StateMergeStep[] } | undefined {
    const set = process.env.RIGOUR_HOME;
    if (!set || path.basename(path.resolve(set)) !== '.rigour') return undefined;
    const outer = path.resolve(set);
    const live = path.join(outer, '.rigour');
    if (!hasState(live)) return undefined;
    const steps: StateMergeStep[] = [];
    const walk = (from: string, into: string, top: boolean) => {
        for (const name of fs.readdirSync(from)) {
            if ((top && name === '.rigour') || /\.merged-\d{4}-\d{2}-\d{2}$/.test(name)) continue;
            const source = path.join(from, name);
            const target = path.join(into, name);
            if (!fs.existsSync(target)) steps.push({ action: 'move', from: source, to: target });
            else if (isDirectory(source) && isDirectory(target)) walk(source, target, false);
            else steps.push({ action: 'aside', from: source, to: `${source}.merged-${date}` });
        }
    };
    walk(outer, live, true);
    return steps.length ? { outer, live, steps } : undefined;
}

/** Carries out a plan from planStateMerge: renames only, never a delete, never onto an existing path. */
export function applyStateMerge(steps: StateMergeStep[]): void {
    for (const step of steps) {
        if (fs.existsSync(step.to)) continue; // never overwrite: a later run's plan names it again
        fs.mkdirSync(path.dirname(step.to), { recursive: true });
        fs.renameSync(step.from, step.to);
    }
}

function isDirectory(file: string): boolean {
    try {
        return fs.statSync(file).isDirectory();
    } catch {
        return false;
    }
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
