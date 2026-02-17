import { describe, it, expect, vi } from 'vitest';
import { FileGuardGate } from './gates/safety.js';
import { Gates } from './types/index.js';
import { execa } from 'execa';

vi.mock('execa');

describe('FileGuardGate', () => {
    const config: Gates = {
        safety: {
            protected_paths: ['docs/'],
            max_files_changed_per_cycle: 10
        }
    } as any;

    it('should flag modified (M) protected files', async () => {
        const gate = new FileGuardGate(config);
        vi.mocked(execa).mockResolvedValueOnce({ stdout: ' M docs/SPEC.md\n' } as any);

        const failures = await gate.run({ cwd: '/test', record: {} as any });
        expect(failures).toHaveLength(1);
        expect(failures[0].title).toContain("Protected file 'docs/SPEC.md' was modified.");
    });

    it('should flag added (A) protected files', async () => {
        const gate = new FileGuardGate(config);
        vi.mocked(execa).mockResolvedValueOnce({ stdout: 'A  docs/NEW.md\n' } as any);

        const failures = await gate.run({ cwd: '/test', record: {} as any });
        expect(failures).toHaveLength(1);
        expect(failures[0].title).toContain("Protected file 'docs/NEW.md' was modified.");
    });

    it('should NOT flag untracked (??) protected files', async () => {
        const gate = new FileGuardGate(config);
        vi.mocked(execa).mockResolvedValueOnce({ stdout: '?? docs/UNTRAKED.md\n' } as any);

        const failures = await gate.run({ cwd: '/test', record: {} as any });
        expect(failures).toHaveLength(0);
    });

    it('should correctly handle multiple mixed statuses', async () => {
        const gate = new FileGuardGate(config);
        vi.mocked(execa).mockResolvedValueOnce({
            stdout: ' M docs/MODIFIED.md\n?? docs/NEW_UNTRACKED.md\n D docs/DELETED.md\n'
        } as any);

        const failures = await gate.run({ cwd: '/test', record: {} as any });
        expect(failures).toHaveLength(2);
        expect(failures.map(f => f.title)).toContain("Protected file 'docs/MODIFIED.md' was modified.");
        expect(failures.map(f => f.title)).toContain("Protected file 'docs/DELETED.md' was modified.");
    });
});
