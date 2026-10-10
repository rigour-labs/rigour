import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { readRepoRules, rulesForDiff, rulesSection, splitRules } from './repo-rules.js';

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
        expect(rules.map(r => r.requirement)).toEqual([true, true, false]); // "never", "every"; "prefer" is guidance
        // A section that only describes an exception, with no imperative, is guidance; one that ends in an imperative is a requirement.
        const [exceptionOnly, withImperative] = splitRules('AGENTS.md', '- **One narrow exception:** the queue table is still literally named `study_jobs`, not renamed with the feature.\n\n- **One narrow exception:** the queue table is still literally named `study_jobs`. Import the `JOBS_TABLE` constant; do not inline the raw table name again.\n');
        expect([exceptionOnly.requirement, withImperative.requirement]).toEqual([false, true]);
        expect(rules[0].id).toMatch(/^[0-9a-f]{10}$/);
        expect(splitRules('AGENTS.md', AGENTS)[0].id).toBe(rules[0].id); // stable across runs
    });

    it('makes each numbered rule its own rule, whole, and never the paragraph that introduces the list', () => {
        const numbered = [
            'Agents working in this repository follow the rules below:',
            '',
            '1. Every job in `src/jobs/` must take the advisory lock before its first read.',
            '2. Never read a whole table in a request handler: page it with a keyset.',
            '3. Bound both ends of every time window a scheduled job reads.',
            '   - The lower bound comes from the last run, never from the clock.',
            '4. Migrations are append-only: add a new file, never edit an applied one.',
            '5. Every new read path names the index it uses in the pull request.',
            '6. Do not log a token, a cookie or a full request body.',
        ].join('\n');
        const rules = splitRules('AGENTS.md', numbered);
        expect(rules.map(r => r.text)).toEqual([
            'Every job in `src/jobs/` must take the advisory lock before its first read.',
            'Never read a whole table in a request handler: page it with a keyset.',
            'Bound both ends of every time window a scheduled job reads. - The lower bound comes from the last run, never from the clock.',
            'Migrations are append-only: add a new file, never edit an applied one.',
            'Every new read path names the index it uses in the pull request.',
            'Do not log a token, a cookie or a full request body.',
        ]);
        expect(rules.every(r => !r.text.endsWith('…'))).toBe(true);
        // A long prose rule is served whole, never cut.
        const long = `Object access is checked per resource: ${'every data-bearing route checks the caller can read it, '.repeat(14)}and nothing else.`;
        expect(splitRules('AGENTS.md', long)[0].text).toBe(long);
        // The same list with bullets, and a lead-in with no blank line before it, read the same way.
        expect(splitRules('AGENTS.md', numbered.replace(/^\d\. /gm, '- ').replace(':\n\n', ':\n')).map(r => r.text)).toHaveLength(6);
        // A paragraph that does not introduce a list is a rule, colon or not.
        expect(splitRules('AGENTS.md', 'Release notes are written for the people who upgrade, not for us:\n\nKeep them short.').map(r => r.text)).toEqual(['Release notes are written for the people who upgrade, not for us:']);
    });

    it('keeps a rule\'s "Why" and "How to apply" paragraphs with it, and ranks a rule naming the change above one that only shares its words', () => {
        const text = '- **Use the design system.** Every control comes from `src/lib/ui`.\n\n**Why:** one source of styling.\n\n**How to apply:** import from `$lib/ui`, never a raw `<button>`.\n\n- Bound both ends of every time window a scheduled job reads.\n\n- Name the index a new query relies on in the migrations.\n';
        const rules = splitRules('AGENTS.md', text);
        expect(rules.map(r => r.text.slice(0, 24))).toEqual(['**Use the design system.', 'Bound both ends of every', 'Name the index a new que']);
        expect(rules[0].text).toContain('**How to apply:**');
        fs.writeFileSync(path.join(repo, 'AGENTS.md'), text);
        const change = diff('src/lib/ui/Button.svelte', 'const timeWindow = scheduledJob.readsRows();');
        expect(rulesForDiff(repo, change, true, 10).map(r => r.text.slice(0, 12))).toEqual(['**Use the de', 'Bound both e']); // the path hit first, then shared words; the index rule shares nothing
        expect(rulesForDiff(repo, change, true, 1)).toHaveLength(1);
    });

    it('shows only the rules that name what the change touches, and nothing when disabled', () => {
        expect(rulesForDiff(repo, diff('migrations/2026_add.sql', 'alter table x;'), true).map(r => r.text.slice(0, 20))).toEqual(['**Migrations are app']);
        expect(rulesForDiff(repo, diff('src/jobs/send.ts', 'await deliverOrder(order);'), true).map(r => r.text.slice(0, 20))).toEqual(['Every outbound send ']);
        expect(rulesForDiff(repo, diff('src/ui/List.tsx', 'const x = 1;'), true)).toEqual([]);
        expect(rulesForDiff(repo, diff('migrations/2026_add.sql', 'x'), false)).toEqual([]);
        expect(rulesSection(rulesForDiff(repo, diff('src/a.ts', 'await fetchWithTimeout(url);'), true))).toContain('[AGENTS.md] Prefer `fetchWithTimeout`');
    });
});

describe('the rule files a judge is given', () => {
    it('follows @ imports from a rule file and reads AGENTS.md and CLAUDE.md in folders below the root, once each', () => {
        fs.writeFileSync(path.join(repo, 'CLAUDE.md'), '@AGENTS.md\n@docs/conventions.md\n@../outside.md\n@/etc/hosts\n@docs/missing.md\n');
        fs.mkdirSync(path.join(repo, 'docs'));
        fs.writeFileSync(path.join(repo, 'docs/conventions.md'), '@../AGENTS.md\n\n- Never log `apiToken` from `src/auth/session.ts`, even partly.\n');
        fs.writeFileSync(path.join(repo, 'SHARED.md'), '- Every job in `src/jobs/` takes `withLock()` before the first read.\n');
        fs.mkdirSync(path.join(repo, 'services/billing'), { recursive: true });
        fs.writeFileSync(path.join(repo, 'services/billing/AGENTS.md'), '- Amounts in `services/billing/` are integer cents via `toCents()`; never a float.\n');
        execFileSync('git', ['-C', repo, 'init', '-q']);
        execFileSync('git', ['-C', repo, 'add', '-A']);
        const rules = readRepoRules(repo);
        const by = (source: string) => rules.filter(r => r.source === source).map(r => r.text);
        expect(by('docs/conventions.md')).toEqual(['Never log `apiToken` from `src/auth/session.ts`, even partly.']);
        expect(by('SHARED.md')).toEqual(['Every job in `src/jobs/` takes `withLock()` before the first read.']); // imported by AGENTS.md
        expect(by('services/billing/AGENTS.md')).toEqual(['Amounts in `services/billing/` are integer cents via `toCents()`; never a float.']);
        expect(rules.filter(r => r.source === 'AGENTS.md')).toHaveLength(3); // imported twice, read once
        expect(rules.some(r => /hosts|outside/.test(r.source))).toBe(false); // nothing outside the repository
    });

    it("applies a folder's own rules, and the rules it imports, only to changes in that folder; vendored folders add none", () => {
        fs.mkdirSync(path.join(repo, 'services/billing'), { recursive: true });
        fs.writeFileSync(path.join(repo, 'services/billing/AGENTS.md'), '@money.md\n\n- Never call `stripe.charges.create` directly from `services/billing/`; go through `ledgerClient`.\n');
        fs.writeFileSync(path.join(repo, 'services/billing/money.md'), '- Every amount in `services/billing/` is integer cents via `toCents()`; never a float.\n');
        fs.mkdirSync(path.join(repo, 'vendor/somelib'), { recursive: true });
        fs.writeFileSync(path.join(repo, 'vendor/somelib/AGENTS.md'), '- Always run `make vendor-test` in `vendor/somelib/` before every commit.\n');
        execFileSync('git', ['-C', repo, 'init', '-q']);
        execFileSync('git', ['-C', repo, 'add', '-A']);
        const all = readRepoRules(repo);
        expect(all.filter(r => r.scope === 'services/billing/').map(r => r.source)).toEqual(['services/billing/AGENTS.md', 'services/billing/money.md']);
        expect(all.some(r => r.source.startsWith('vendor/'))).toBe(false);
        expect(all.filter(r => r.source === 'AGENTS.md').every(r => r.scope === undefined)).toBe(true);
        // A change only in web/ that even names the billing words: the billing rules are not served, so never checked or broken.
        const web = rulesForDiff(repo, diff('web/src/Price.tsx', 'const total = stripe.charges.create(toCents(amount));'), true, 15);
        expect(web.some(r => r.scope)).toBe(false);
        const billing = rulesForDiff(repo, diff('services/billing/charge.ts', 'const total = stripe.charges.create(toCents(amount));'), true, 15);
        expect(billing.filter(r => r.scope).map(r => r.source).sort()).toEqual(['services/billing/AGENTS.md', 'services/billing/money.md']);
    });
});
