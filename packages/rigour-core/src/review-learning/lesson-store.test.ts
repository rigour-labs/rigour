import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decideLesson, lessonsPath, readLessons, scopeLesson, type ReviewLesson, writeLessons, updateLessons } from './lessons.js';
import { seedLessons } from './seed-lessons.test-support.js';

const candidate = (id: string, file: string, text: string): ReviewLesson => ({
    id, text, file, symbols: ['loadOrders'], state: 'candidate', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    evidence: [{ kind: 'point', pr: 1, comment: `${id}-1`, author: 'senior-reviewer', source: 'person' }],
});

describe('two writers on the review lessons store', () => {
    let repo: string;
    beforeEach(() => {
        repo = fs.mkdtempSync(path.join(os.tmpdir(), 'lesson-store-'));
        seedLessons(repo, [candidate('scan', 'src/orders.ts', 'Filter in the query, not after a full read.')]);
    });
    afterEach(() => { vi.restoreAllMocks(); fs.rmSync(repo, { recursive: true, force: true }); });

    it('a decision made while a long run works is kept when the run writes', () => {
        const read = readLessons(repo);
        const ours = structuredClone(read);
        ours[0].evidence.push({ kind: 'lines', pr: 1, comment: 'lines-scan', author: '' });
        ours.push(candidate('echo', 'src/log.ts', 'Do not log identifiers from config objects.'));

        decideLesson(repo, 'scan', 'accepted', 'lead@example.com', 'we always filter in SQL');
        writeLessons(repo, ours, read);

        const stored = readLessons(repo);
        const scan = stored.find(l => l.id === 'scan')!;
        expect(scan.evidence.map(e => e.kind)).toEqual(['point', 'accepted', 'lines']);
        expect(scan.state).toBe('verified');
        expect(stored.map(l => l.id)).toEqual(['scan', 'echo']);
    });

    it('keeps the field each side changed: their scope, our wording', () => {
        const read = readLessons(repo);
        const ours = structuredClone(read);
        ours[0].text = 'Filter rows in the query.';

        scopeLesson(repo, 'scan', 'repo', 'lead@example.com');
        writeLessons(repo, ours, read);

        const scan = readLessons(repo)[0];
        expect(scan.scope).toBe('repo');
        expect(scan.text).toBe('Filter rows in the query.');
        expect(scan.evidence.filter(e => e.kind === 'scoped')).toHaveLength(1);
    });

    it('keeps a lesson the other writer added', () => {
        const read = readLessons(repo);
        updateLessons(repo, lessons => { lessons.push(candidate('late', 'src/late.ts', 'Close the cursor in a finally block.')); });
        writeLessons(repo, structuredClone(read), read);
        expect(readLessons(repo).map(l => l.id).sort()).toEqual(['late', 'scan']);
    });

    it('leaves no lock and no temporary file behind, also when a change throws', () => {
        expect(() => scopeLesson(repo, 'scan', 'folder', 'lead@example.com')).not.toThrow();
        updateLessons(repo, lessons => { lessons.push(candidate('nofile', '', 'Name things after what they mean.')); });
        expect(() => scopeLesson(repo, 'nofile', 'folder', 'lead@example.com')).toThrow(/no folder/);
        expect(fs.readdirSync(path.dirname(lessonsPath(repo)))).toEqual(['review-lessons.json']);
    });

    it('takes over a lock left by a writer that died', () => {
        const lock = `${lessonsPath(repo)}.lock`;
        fs.writeFileSync(lock, '');
        const old = new Date(Date.now() - 60_000);
        fs.utimesSync(lock, old, old);
        expect(decideLesson(repo, 'scan', 'rejected', 'lead@example.com')?.state).toBe('rejected');
        expect(fs.existsSync(lock)).toBe(false);
    });

    it('waits for a live lock, then refuses rather than overwrite', () => {
        fs.writeFileSync(`${lessonsPath(repo)}.lock`, '');
        const start = Date.now();
        let calls = 0;
        vi.spyOn(Date, 'now').mockImplementation(() => start + (calls++ > 2 ? 20_000 : 0));
        expect(() => decideLesson(repo, 'scan', 'accepted', 'lead@example.com')).toThrow(/locked by another writer/);
        vi.restoreAllMocks();
        expect(readLessons(repo)[0].state).toBe('candidate');
    });
});
