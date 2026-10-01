import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rulesForDiff, rulesSection, splitRules } from './repo-rules.js';

const AGENTS = `# Conventions

@SHARED.md

- **Migrations are append-only.** Add new files under \`migrations/\`; never edit applied ones.
- Every outbound send goes through \`deliverOrder()\` in \`src/lib/delivery.ts\`, which checks the permit.
- Keep components small.

Prefer \`fetchWithTimeout\` over a bare call when talking to partner APIs; a hung request blocks the queue.
`;

let repo: string;
beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-rules-'));
    fs.writeFileSync(path.join(repo, 'AGENTS.md'), AGENTS);
    fs.mkdirSync(path.join(repo, '.cursor/rules'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.cursor/rules/ui.mdc'), 'Never set `fullWidth` on `<Button>`; use `maxWidth` caps instead of stretching.\n');
});
afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

const diff = (file: string, added: string) => `+++ b/${file}\n@@ -1,0 +1,1 @@\n+${added}\n`;

describe('repository rules', () => {
    it('splits a rules file into rules with the paths and specific identifiers they name', () => {
        const rules = splitRules('AGENTS.md', AGENTS);
        expect(rules.map(r => r.text.slice(0, 30))).toEqual(['**Migrations are append-only.*', 'Every outbound send goes throu', 'Prefer `fetchWithTimeout` over']);
        expect(rules[1]).toMatchObject({ paths: ['src/lib/delivery.ts'], symbols: ['deliverOrder'] });
        expect(rules[0].paths).toEqual(['migrations/']);
    });

    it('shows only the rules that name what the change touches, and nothing when disabled', () => {
        expect(rulesForDiff(repo, diff('migrations/2026_add.sql', 'alter table x;'), true).map(r => r.text.slice(0, 20))).toEqual(['**Migrations are app']);
        expect(rulesForDiff(repo, diff('src/jobs/send.ts', 'await deliverOrder(order);'), true).map(r => r.text.slice(0, 20))).toEqual(['Every outbound send ']);
        expect(rulesForDiff(repo, diff('src/ui/List.tsx', 'const x = 1;'), true)).toEqual([]);
        expect(rulesForDiff(repo, diff('migrations/2026_add.sql', 'x'), false)).toEqual([]);
        expect(rulesSection(rulesForDiff(repo, diff('src/a.ts', 'await fetchWithTimeout(url);'), true))).toContain('[AGENTS.md] Prefer `fetchWithTimeout`');
    });
});
