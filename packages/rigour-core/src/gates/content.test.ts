import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ContentGate } from './content.js';

describe('ContentGate', () => {
    let testDir: string;

    beforeEach(() => {
        testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'content-gate-test-'));
    });

    afterEach(() => {
        fs.rmSync(testDir, { recursive: true, force: true });
    });

    it('flags TODO and FIXME in comments', async () => {
        fs.writeFileSync(path.join(testDir, 'app.ts'), `
            // TODO: remove temporary fallback
            const value = 1;
            const x = value; // FIXME clean this before release
        `);

        const gate = new ContentGate({ forbidTodos: true, forbidFixme: true });
        const failures = await gate.run({ cwd: testDir });

        expect(failures).toHaveLength(2);
    });

    it('does not flag TODO or FIXME in non-comment string literals', async () => {
        fs.writeFileSync(path.join(testDir, 'app.ts'), `
            const message = "TODO this is user-facing text";
            const note = "FIXME should not trigger in strings";
        `);

        const gate = new ContentGate({ forbidTodos: true, forbidFixme: true });
        const failures = await gate.run({ cwd: testDir });

        expect(failures).toHaveLength(0);
    });

    it('does not scan markdown files', async () => {
        fs.writeFileSync(path.join(testDir, 'README.md'), `
            # TODO
            This is a product roadmap item.
        `);

        const gate = new ContentGate({ forbidTodos: true, forbidFixme: true });
        const failures = await gate.run({ cwd: testDir });

        expect(failures).toHaveLength(0);
    });

    it('respects config toggles', async () => {
        fs.writeFileSync(path.join(testDir, 'app.ts'), `
            // TODO: one
            // FIXME: two
        `);

        const todoOnly = new ContentGate({ forbidTodos: true, forbidFixme: false });
        const todoFailures = await todoOnly.run({ cwd: testDir });
        expect(todoFailures).toHaveLength(1);
        expect(todoFailures[0].details).toContain("TODO");

        const fixmeOnly = new ContentGate({ forbidTodos: false, forbidFixme: true });
        const fixmeFailures = await fixmeOnly.run({ cwd: testDir });
        expect(fixmeFailures).toHaveLength(1);
        expect(fixmeFailures[0].details).toContain("FIXME");
    });

    it('does not flag explanatory mentions of TODO/FIXME in comments', async () => {
        fs.writeFileSync(path.join(testDir, 'notes.ts'), `
            // counts TODO and FIXME markers from parsed files
            const metrics = true;
        `);

        const gate = new ContentGate({ forbidTodos: true, forbidFixme: true });
        const failures = await gate.run({ cwd: testDir });

        expect(failures).toHaveLength(0);
    });

    it('skips test/spec files', async () => {
        fs.writeFileSync(path.join(testDir, 'sample.test.ts'), `
            // TODO: this should not be checked by content gate
        `);

        const gate = new ContentGate({ forbidTodos: true, forbidFixme: true });
        const failures = await gate.run({ cwd: testDir });

        expect(failures).toHaveLength(0);
    });
});
