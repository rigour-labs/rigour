import { describe, expect, it } from 'vitest';
import { aboutAnotherRepository, buildActivity, groupSessions, readableFunction } from './studio-activity.js';

describe('buildActivity', () => {
    it('turns the record into sentences, newest first, and leaves raw tool traffic out', () => {
        const items = buildActivity({
            events: [
                { type: 'hook_check', timestamp: '2026-10-09T10:00:00Z', blocked: true, files: ['src/pay.ts'], findings: [{ message: 'Stripe API key detected in code' }] } as any,
                { type: 'tool_call', timestamp: '2026-10-09T10:01:00Z', tool: 'rigour_recall' },
                { type: 'stop_review', timestamp: '2026-10-09T10:03:00Z', blocked: true, blocking: 1 },
                { type: 'lessons_served', timestamp: '2026-10-09T10:04:00Z', via: 'recall', lessons: ['Amounts are cents'] },
            ],
            ledger: [{ file: 'src/refund.ts', function: 'issueRefund', hash: 'h', reviewer: 'agent', verdict: 'fixed', note: 'Read the row under lock.', at: '2026-10-09T10:05:00Z' }],
            stories: [{ id: 's', at: '2026-10-09T10:02:00Z', stage: 'edit', file: 'src/pay.ts', rule: 'security-patterns', title: 'Stripe API key detected in code', diff: [] }],
        });
        expect(items.map(i => i.text)).toEqual([
            'Fixed `issueRefund` in src/refund.ts',
            'Told the agent 1 lesson before it wrote',
            'Kept the agent working: 1 problem left when it tried to finish',
            'Fixed: Stripe API key detected in code',
            'Stopped an edit to src/pay.ts: Stripe API key detected in code',
        ]);
    });

    it('names what held the agent at the stop, as the edit line names what it stopped', () => {
        const stop = (findings: Array<{ rule: string; title: string; file: string }>) => buildActivity({ events: [{ type: 'stop_review', timestamp: '2026-10-09T10:00:00Z', blocked: true, blocking: findings.length, findings }], ledger: [], stories: [] })[0];
        expect(stop([{ rule: 'hallucinated-imports', title: 'Hallucinated Imports', file: 'src/jobs/retry.ts', detail: "L1: import '../nope.js' — does not resolve" } as any]).text)
            .toBe("Kept the agent working until it fixed src/jobs/retry.ts: Hallucinated Imports (L1: import '../nope.js' — does not resolve)");
        expect(stop([{ rule: 'a', title: 'One', file: 'a.ts' }, { rule: 'b', title: 'Two', file: 'b.ts' }])).toMatchObject({ text: 'Kept the agent working: 2 problems left when it tried to finish', detail: 'a.ts: One · b.ts: Two' });
    });

    it('never says an edit was stopped when the hook ran without --block, or did not record it', () => {
        const check = (blocked?: boolean) => ({ type: 'hook_check', timestamp: '2026-10-09T10:00:00Z', ...(blocked === undefined ? {} : { blocked }), files: ['src/a.ts'], findings: [{ message: 'Import not found' }] }) as any;
        for (const event of [check(false), check()]) {
            const [item] = buildActivity({ events: [event], ledger: [], stories: [] });
            expect([item.kind, item.text]).toEqual(['reported', 'Reported on an edit to src/a.ts: Import not found']);
        }
        expect(groupSessions(buildActivity({ events: [check()], ledger: [], stories: [] }))[0]).toMatchObject({ counts: { reported: 1, stopped: 0 }, rest: [] });
    });

    it('names unnamed functions the way people do', () => {
        expect(readableFunction('<anonymous>@17', 'src/proxy.test.ts')).toBe('the test at line 17');
        expect(readableFunction('<anonymous>@4', 'src/a.ts')).toBe('the function at line 4');
        expect(readableFunction('loadDiagnosis', 'src/a.ts')).toBe('`loadDiagnosis`');
    });

    it('groups activity into sessions, with fixes up front and routine items folded', () => {
        const item = (at: string, kind: any, text = 'x') => ({ at, kind, text });
        const sessions = groupSessions([
            item('2026-10-09T12:00:00Z', 'reviewed', 'Reviewed `a` in a.ts: no issue'),
            item('2026-10-09T11:50:00Z', 'reviewed', 'Fixed `b` in b.ts'),
            item('2026-10-09T11:40:00Z', 'checked'),
            item('2026-10-09T08:00:00Z', 'stopped'),
        ]);
        expect(sessions).toHaveLength(2);
        expect(sessions[0].counts).toMatchObject({ reviewed: 2, reviewedFixed: 1, checked: 1 });
        expect(sessions[0].highlights.map(i => i.text)).toEqual(['Fixed `b` in b.ts']);
        expect(sessions[0].rest).toHaveLength(2);
        expect(sessions[1].highlights).toHaveLength(1);
    });

    it("leaves out old edit events that were about another repository's files", () => {
        expect(aboutAnotherRepository({ type: 'hook_check', files: ['/work/other/src/a.ts'] } as any, ['/work/app'])).toBe(true);
        expect(aboutAnotherRepository({ type: 'hook_check', files: ['/work/app/src/a.ts'] } as any, ['/work/app'])).toBe(false);
        expect(aboutAnotherRepository({ type: 'hook_check', files: ['src/a.ts'] } as any, ['/work/app'])).toBe(false);
    });
});
