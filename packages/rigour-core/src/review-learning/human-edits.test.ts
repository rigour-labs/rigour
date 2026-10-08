import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureHumanEdits, recordAgentWrites } from './human-edits.js';
import { readLessons } from './lessons.js';

let repo: string;
const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
const write = (body: string) => fs.writeFileSync(path.join(repo, 'src/job.ts'), body);

beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'human-edits-'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 't');
    git('config', 'commit.gpgsign', 'false');
    fs.mkdirSync(path.join(repo, 'src'));
    write('export function job(rows) {\n  return rows.map(r => r.id);\n}\n');
    git('add', '-A');
    git('commit', '-qm', 'base');
});
afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

describe('a person editing what the agent wrote', () => {
    it('becomes a lesson with correction evidence, taken once', () => {
        write('export function job(rows) {\n  return rows.slice(0, 10000).map(r => r.id);\n}\n'); // the agent's write
        recordAgentWrites(repo, ['src/job.ts']);
        write('export function job(rows, after) {\n  return rows.filter(r => r.id > after).slice(0, 500).map(r => r.id);\n}\n'); // the person's fix
        expect(captureHumanEdits(repo, 'lead@acme')).toBe(1);
        const [lesson] = readLessons(repo);
        expect(lesson).toMatchObject({ file: 'src/job.ts', state: 'verified', promotedBy: 'correction' });
        expect(lesson.text).toContain('a person changed what the agent wrote');
        expect(lesson.text).toContain('+  return rows.filter(r => r.id > after).slice(0, 500).map(r => r.id);');
        expect(lesson.evidence[0]).toMatchObject({ kind: 'correction', author: 'lead@acme' });
        expect(captureHumanEdits(repo, 'lead@acme')).toBe(0); // taken once
    });

    it('is not a correction when only whitespace moved, or the change came from git', () => {
        recordAgentWrites(repo, ['src/job.ts']);
        write('export function job(rows) {\n    return rows.map(r => r.id);\n}\n'); // a formatter
        expect(captureHumanEdits(repo)).toBe(0);
        recordAgentWrites(repo, ['src/job.ts']);
        git('checkout', '-q', '-b', 'other');
        write('export const job = (rows) => rows.map(r => r.id);\n');
        git('commit', '-qam', 'someone else\'s branch');
        expect(captureHumanEdits(repo)).toBe(0); // a checkout brought it, not a person correcting the agent
        expect(readLessons(repo)).toEqual([]);
    });
});
