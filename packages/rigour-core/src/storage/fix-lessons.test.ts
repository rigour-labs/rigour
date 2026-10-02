import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedFix } from '../review/agent-fixes.js';

/** An in-memory lessons table, enough for the reads and writes fix lessons make. */
const db = vi.hoisted(() => ({ rows: new Map<string, any>(), reset() { this.rows = new Map(); } }));

vi.mock('./db.js', () => {
    const store = {
        run: async (sql: string, ...p: any[]) => {
            if (sql.includes('INSERT INTO lessons')) db.rows.set(p[0], { id: p[0], state: p[4], subject: p[5], evidence_json: p[6], confidence: p[7] });
            if (sql.includes('UPDATE lessons')) {
                const row = db.rows.get(p[4]);
                if (!['promoted', 'rejected'].includes(row.state)) row.state = p[0];
                Object.assign(row, { evidence_json: p[1], confidence: Math.max(row.confidence, p[2]) });
            }
            return { changes: 1, lastID: 0 };
        },
        get: async (sql: string, ...p: any[]) => (sql.includes("kind = 'fix'") ? [...db.rows.values()].find(r => r.subject.slice(0, p[1]) === p[2]) : undefined),
        all: async () => [],
        exec: async () => undefined,
        close: async () => undefined,
    };
    return { openDatabase: async () => store };
});
vi.mock('./local-encryption.js', () => ({ encryptLocalPayload: async (v: unknown) => JSON.stringify(v), decryptLocalPayload: async (v: string) => JSON.parse(v) }));
vi.mock('./team-store.js', () => ({ loadTeamConfiguration: async () => null }));

const { recordFixLessons, fixLessonSubject } = await import('./fix-lessons.js');

const fix = (id: string, file: string): ResolvedFix => ({
    id, file, rule: 'semantic-bugs', title: 'Unbounded read without paging', details: 'Rows read without a limit.', before: 'a', after: 'b', resolvedAt: '2026-10-02T00:00:00Z',
});
const lessons = () => [...db.rows.values()];

beforeEach(() => db.reset());

describe('recordFixLessons', () => {
    it('turns a fix into a candidate lesson named after the defect it removed', async () => {
        await recordFixLessons(process.cwd(), [fix('f1', 'src/orders.ts')]);
        expect(lessons().map(l => [l.subject, l.state])).toEqual([['Fixed before: Unbounded read without paging (semantic-bugs). Rows read without a limit.', 'candidate']]);
    });

    it('validates the lesson once fixes of that kind reach a second file, and counts the same fix once', async () => {
        await recordFixLessons(process.cwd(), [fix('f1', 'src/orders.ts')]);
        await recordFixLessons(process.cwd(), [fix('f1', 'src/orders.ts'), fix('f2', 'src/orders.ts')]);
        expect(lessons()[0].state).toBe('candidate');
        await recordFixLessons(process.cwd(), [fix('f3', 'src/invoices.ts')]);
        expect(lessons()).toHaveLength(1);
        expect(lessons()[0].state).toBe('validated');
        expect(JSON.parse(lessons()[0].evidence_json).files).toEqual(['src/orders.ts', 'src/invoices.ts']);
    });

    it("never overrides a person's decision to promote or reject", async () => {
        await recordFixLessons(process.cwd(), [fix('f1', 'src/orders.ts')]);
        lessons()[0].state = 'rejected';
        await recordFixLessons(process.cwd(), [fix('f2', 'src/invoices.ts')]);
        expect(lessons()[0].state).toBe('rejected');
    });

    it('names a fix whose finding had no title after its rule', () => {
        expect(fixLessonSubject({ rule: 'hallucinated-imports' })).toBe('Fixed before: hallucinated-imports (hallucinated-imports).');
    });

    it('groups fixes of one kind even when their details differ', async () => {
        await recordFixLessons(process.cwd(), [fix('f1', 'src/orders.ts')]);
        await recordFixLessons(process.cwd(), [{ ...fix('f2', 'src/invoices.ts'), details: 'Invoices read in full to count them.' }]);
        expect(lessons()).toHaveLength(1);
        expect(lessons()[0].state).toBe('validated');
    });
});
