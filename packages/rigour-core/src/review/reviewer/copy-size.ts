/**
 * Whether the judges' copies fit (review.reviewer.run_code_max_mb, and the free disk), and what a copy leaves out.
 * Measured before anything is copied: the reviewed commit's files (`git ls-tree -l`), plus its objects when the
 * temporary directory is on another volume (on the same one they are hardlinked, nothing copied). run_code is refused,
 * and said, when one copy is over the setting or the free space is under twice what the review's copies take.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const MB = 1024 * 1024;
const git = (cwd: string, args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * MB });

/** The bytes one copy of `head` takes, or undefined when git cannot say. */
function copyBytes(cwd: string, head: string, tmp: string = os.tmpdir()): number | undefined {
    const tree = git(cwd, ['ls-tree', '-r', '-l', '-z', head]);
    if (tree.status !== 0) return undefined;
    let bytes = 0;
    for (const entry of tree.stdout.split('\0')) bytes += Number(/^\S+ blob \S+\s+(\d+)\t/.exec(entry)?.[1] ?? 0);
    const common = git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']).stdout.trim();
    if (common && fs.statSync(common).dev !== fs.statSync(tmp).dev) {
        const counted = git(cwd, ['count-objects', '-v']).stdout;
        bytes += ['size', 'size-pack'].reduce((sum, key) => sum + Number(new RegExp(`^${key}: (\\d+)$`, 'm').exec(counted)?.[1] ?? 0) * 1024, 0);
    }
    return bytes;
}

function freeBytes(dir: string): number {
    const stat = fs.statfsSync(dir);
    return stat.bavail * stat.bsize;
}

/** Why the review's `copies` copies of `head` may not be made, or undefined when they may. */
export function copySizeRefusal(cwd: string, head: string, maxMb: number, copies: number, tmp: string = os.tmpdir(), free: number = freeBytes(tmp)): string | undefined {
    const bytes = copyBytes(cwd, head, tmp);
    if (bytes === undefined) return `run_code refused: the size of ${head.slice(0, 9)} could not be measured; every judge stays read-only`;
    const mb = Math.ceil(bytes / MB);
    if (mb > maxMb) return `run_code refused: a copy of ${head.slice(0, 9)} takes ${mb} MB, over review.reviewer.run_code_max_mb (${maxMb}); every judge stays read-only`;
    if (free < 2 * bytes * copies) return `run_code refused: ${Math.floor(free / MB)} MB free in ${tmp}, under twice the ${mb * copies} MB the judges' copies take; every judge stays read-only`;
    return undefined;
}

/** What a copy of `head` does not hold: submodules (never checked out) and Git LFS files (pointers only). */
export function copyCaveats(cwd: string, head: string): string[] {
    const tree = git(cwd, ['ls-tree', '-r', '-z', head]).stdout.split('\0').filter(Boolean);
    const caveats: string[] = [];
    if (tree.some(entry => entry.startsWith('160000 '))) caveats.push("run_code: submodules are not checked out in the judge's copy");
    const attributes = tree.map(entry => entry.split('\t')[1]).filter(file => file && path.basename(file) === '.gitattributes');
    if (attributes.some(file => /filter=lfs/.test(git(cwd, ['show', `${head}:${file}`]).stdout))) caveats.push("run_code: Git LFS files are pointers, not their content, in the judge's copy");
    return caveats;
}
