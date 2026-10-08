/**
 * A team setting written from Studio: rigour.yml in the working tree, comments and layout kept, never committed. Team
 * policy still reaches everyone through a reviewed commit, so the caller shows the diff to commit.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import YAML from 'yaml';
import { ConfigSchema } from '@rigour-labs/core';

/**
 * Sets each key path to its value (`null` removes it: Rigour's default again) and returns the diff to commit. The whole
 * file must still be a valid rigour.yml before it is written. A missing file is created only when asked (`create`),
 * since that turns a personal install into the team's.
 */
export function writeTeamSettings(cwd: string, edits: Array<[string[], unknown]>, create: boolean): string {
    const file = path.join(cwd, 'rigour.yml');
    const exists = fs.existsSync(file);
    if (exists && fs.lstatSync(file).isSymbolicLink()) throw new Error('rigour.yml is a link: edit the file it points to directly');
    if (!exists && !create) throw new Error('there is no rigour.yml: creating one makes this the team\'s setup, so confirm it (create: true)');
    const doc = exists ? YAML.parseDocument(fs.readFileSync(file, 'utf8')) : new YAML.Document({});
    if (doc.errors.length) throw new Error(`rigour.yml does not parse: ${doc.errors[0].message}`);
    for (const [key, value] of edits) {
        if (value === null) doc.deleteIn(key);
        else doc.setIn(key, value);
    }
    const parsed = ConfigSchema.safeParse(doc.toJS());
    if (!parsed.success) throw new Error(`that would not be a valid rigour.yml: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    fs.writeFileSync(file, String(doc));
    return diffOf(cwd, exists);
}

/** What the person will commit: git's diff of rigour.yml, or the whole new file. */
function diffOf(cwd: string, existed: boolean): string {
    if (!existed) return fs.readFileSync(path.join(cwd, 'rigour.yml'), 'utf8').split('\n').filter(Boolean).map(line => `+${line}`).join('\n');
    try {
        return execFileSync('git', ['diff', '--no-color', '--unified=1', '--', 'rigour.yml'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
            .split('\n').filter(line => /^[+-](?![+-])/.test(line) || line.startsWith('@@')).join('\n');
    } catch {
        return '';
    }
}
