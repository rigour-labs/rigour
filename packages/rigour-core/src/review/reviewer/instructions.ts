/**
 * The team's review instructions (review.reviewer.instructions): a rubric in the repository, served to every judge after
 * Rigour's own prompt. It is read where the reviewer reads its settings: from the base for an independent review
 * (trustedRef), so a pull request cannot rewrite the rubric it is judged by, else from the working tree. A path that
 * leaves the repository, directly or through a symlink, is refused. A file that cannot be served is said, never hidden:
 * the review runs with the general prompt and says so.
 */
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

const INSTRUCTIONS_MAX_BYTES = 32 * 1024;
/** Symlinks followed inside a commit before the path counts as unreadable. */
const MAX_LINK_HOPS = 8;

export interface TeamInstructions {
    path: string;
    /** Where they were read: `the working tree`, or `the base <sha>`. */
    from: string;
    /** What the judge is given (at most INSTRUCTIONS_MAX_BYTES), when it could be read. */
    text?: string;
    /** sha256 of the whole file, when it could be read. */
    hash?: string;
    /** Bytes in the file, when it is over the limit. */
    truncatedFrom?: number;
    /** Why nothing was served: the line the review shows. */
    problem?: string;
}

const GENERAL = 'reviewed with the general prompt';

/** The instructions at `rel`, read at `ref` (an independent review's base) or in the working tree of `root`. */
export function readInstructions(root: string, rel: string, ref?: string): TeamInstructions {
    const from = ref ? `the base ${ref.slice(0, 9)}` : 'the working tree';
    const said = (problem: string) => ({ path: rel, from, problem: `review instructions ${rel} ${problem}; ${GENERAL}${ref ? ` (read from ${from}: an independent review trusts the base)` : ''}` });
    const inside = insideRepository(rel);
    if (!inside) return said('resolve outside the repository and were refused');
    const read = ref ? readAtRef(root, inside, ref) : readWorkingTree(root, inside);
    if ('problem' in read) return said(read.problem);
    if (read.bytes.length === 0) return said('are empty');
    const over = read.bytes.length > INSTRUCTIONS_MAX_BYTES;
    return {
        path: rel, from,
        text: read.bytes.subarray(0, INSTRUCTIONS_MAX_BYTES).toString('utf8'),
        hash: createHash('sha256').update(read.bytes).digest('hex').slice(0, 16),
        ...(over ? { truncatedFrom: read.bytes.length } : {}),
    };
}

/** What the review says about the instructions besides serving them: why they were not served, or that they were cut. */
export function instructionsCaveats(i: TeamInstructions | undefined): string[] {
    if (!i) return [];
    if (i.problem) return [i.problem];
    return i.truncatedFrom ? [`review instructions ${i.path}: instructions truncated at 32 KB (the file is ${Math.ceil(i.truncatedFrom / 1024)} KB)`] : [];
}

/** Their part of the verdict fingerprint: only when the key is set, so an unset key leaves every existing key as it was. */
export function instructionsKey(i: TeamInstructions | undefined): string[] {
    return i ? [`instructions ${i.path} ${i.hash ?? 'none'}`] : [];
}

/** The path as a repository-relative posix path, or undefined when it is absolute or climbs out. */
function insideRepository(rel: string): string | undefined {
    const posix = rel.replace(/\\/g, '/');
    if (path.isAbsolute(rel) || path.posix.isAbsolute(posix) || /^[A-Za-z]:/.test(posix)) return undefined;
    const normal = path.posix.normalize(posix);
    return normal === '..' || normal.startsWith('../') || normal === '.' ? undefined : normal;
}

function readWorkingTree(root: string, rel: string): { bytes: Buffer } | { problem: string } {
    let real: string;
    try {
        real = fs.realpathSync(path.join(root, rel));
    } catch (error: any) {
        return error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? { problem: 'not found' } : { problem: `could not be read (${error?.message ?? error})` };
    }
    const within = path.relative(fs.realpathSync(root), real);
    if (within.startsWith('..') || path.isAbsolute(within)) return { problem: 'resolve outside the repository and were refused' };
    try {
        if (!fs.statSync(real).isFile()) return { problem: 'not found (not a file)' };
        return { bytes: fs.readFileSync(real) };
    } catch (error: any) {
        return { problem: `could not be read (${error?.message ?? error})` };
    }
}

/** The file at `ref`, following symlinks inside the commit; a link out of the repository is refused. */
function readAtRef(root: string, rel: string, ref: string): { bytes: Buffer } | { problem: string } {
    let at = rel;
    for (let hop = 0; hop <= MAX_LINK_HOPS; hop++) {
        const listed = git(root, ['ls-tree', '-z', ref, '--', at]).toString('utf8');
        const entry = /^(\d+) (\w+) ([0-9a-f]+)\t/.exec(listed);
        if (!entry || entry[2] !== 'blob') return { problem: entry ? 'not found (not a file)' : 'not found' };
        const blob = git(root, ['cat-file', 'blob', entry[3]]);
        if (entry[1] !== '120000') return { bytes: blob };
        const target = blob.toString('utf8');
        const next = path.posix.isAbsolute(target) ? undefined : insideRepository(path.posix.join(path.posix.dirname(at), target));
        if (!next) return { problem: 'resolve outside the repository and were refused' };
        at = next;
    }
    return { problem: `could not be read (more than ${MAX_LINK_HOPS} symlinks)` };
}

function git(cwd: string, args: string[]): Buffer {
    const result = spawnSync('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 });
    return result.status === 0 ? result.stdout : Buffer.alloc(0);
}
