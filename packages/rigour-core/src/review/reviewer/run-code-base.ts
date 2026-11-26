/**
 * Where run_code is read from: the base's rigour.yml, never the reviewed branch's. A branch could otherwise turn
 * run_code on for itself, and have its own code run by the reviewer. The base is the trusted ref when one is given,
 * else the commit the branch left the review's base at (the merge-base). run_code runs only when the base turns it on
 * and the working tree does not turn it off; its size cap (run_code_max_mb) is the base's too. The team's review
 * instructions are not read from here: they are the working tree's, or the base's under --independent.
 */
import { spawnSync } from 'child_process';
import yaml from 'yaml';
import { ConfigSchema } from '../../types/index.js';
import { readStateFile } from '../trusted-state.js';

export interface BaseRunCode { on: boolean; maxMb: number; refused?: string }

/** The commit run_code is read at: `trustedRef`, else the merge-base of `head` and `base`. */
export function runCodeBase(cwd: string, head: string, base: string, trustedRef?: string): string | undefined {
    if (trustedRef) return trustedRef;
    const merged = spawnSync('git', ['merge-base', base, head], { cwd, encoding: 'utf8' });
    return merged.status === 0 ? merged.stdout.trim() || undefined : undefined;
}

/** run_code as the base sets it, with the working tree's `asked`; a refusal says where it was read. */
export function baseRunCode(cwd: string, ref: string | undefined, asked: 'off' | 'on'): BaseRunCode {
    const off = (why: string): BaseRunCode => ({ on: false, maxMb: 0, refused: `run_code refused: run_code is read from ${why}; every judge stays read-only` });
    if (asked !== 'on') return { on: false, maxMb: 0 };
    if (!ref) return off('the base, which could not be found');
    const label = /^[0-9a-f]{40}$/.test(ref) ? ref.slice(0, 9) : ref;
    const text = readStateFile(cwd, 'rigour.yml', ref);
    if (text === null) return off(`${label}, which has no rigour.yml`);
    let parsed: ReturnType<typeof ConfigSchema.safeParse>;
    try {
        parsed = ConfigSchema.safeParse(yaml.parse(text) ?? {});
    } catch {
        return off(`${label}, whose rigour.yml does not parse`);
    }
    if (!parsed.success) return off(`${label}, whose rigour.yml does not parse`);
    const reviewer = parsed.data.review?.reviewer;
    if (reviewer?.run_code !== 'on') return off(`${label}, where it is off`);
    return { on: true, maxMb: reviewer.run_code_max_mb ?? 2048 };
}
