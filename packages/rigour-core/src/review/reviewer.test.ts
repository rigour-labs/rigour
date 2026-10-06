import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigSchema } from '../types/index.js';
import { reviewerBlocks, runReviewer, type Exec, type ReviewerResult } from './reviewer.js';
import { selectReviewers, vendorsOf } from './reviewer/adapters.js';
import { account, carryResolved, mergeVerdicts, parseVerdict, type Verdict } from './reviewer/verdict.js';

let repo: string;
const config = ConfigSchema.parse({ version: 1, review: { github_account: 'reviewer-account', reviewer: { enabled: true, reviewers: ['claude', 'cursor'] } } });
const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();

const PR = { number: 42, state: 'OPEN', isDraft: false, author: { login: 'author' }, body: 'Every read is bounded at both ends.' };
const REVIEWS = [
    { id: 1, user: { login: 'ci-bot', type: 'Bot' }, body: 'automated', state: 'COMMENTED', submitted_at: '2026-10-01', commit_id: 'aaaaaaaaa' },
    { id: 2, user: { login: 'author', type: 'User' }, body: 'self note', state: 'COMMENTED', submitted_at: '2026-10-02', commit_id: 'aaaaaaaaa' },
    { id: 3, user: { login: 'senior', type: 'User' }, body: 'Two blocking points.', state: 'CHANGES_REQUESTED', submitted_at: '2026-10-03', commit_id: 'aaaaaaaaa' },
];
const INLINE = [{ id: 7, user: { login: 'senior', type: 'User' }, path: 'src/job.ts', line: 12, body: 'Check the lock before the first read.', created_at: '2026-10-03', updated_at: '2026-10-03' }];

const EMPTY = { prior_points: [{ point: 'lock before read', severity: 'blocking', resolved: true, evidence: 'a.ts:1' }], redundant: [], reads: [], scans: [], merge_impact: [], findings: [], carried: [], resolved_previous: [] };

interface Seen { prompts: string[]; files: Record<string, string>; ghArgs: string[][]; ran: string[]; ghToken?: string; installed?: string[]; versions?: Record<string, string> }

/** Real git; scripted gh; agent CLIs that record what they were shown and answer `answer` (a function of the reviewer's name). */
function fakes(answer: (reviewer: string) => string | { exitCode: number; stdout: string; stderr: string }, seen: Seen, pr: typeof PR | null = PR): Exec {
    return async (command, args, options) => {
        if (command === 'git') {
            try {
                return { exitCode: 0, stdout: execFileSync('git', args, { cwd: options.cwd, encoding: 'utf8' }), stderr: '' };
            } catch (error: any) {
                return { exitCode: 1, stdout: '', stderr: String(error.message) };
            }
        }
        if (command === 'gh') {
            seen.ghArgs.push(args);
            if (args[0] === 'auth') return { exitCode: 0, stdout: 'token-for-account\n', stderr: '' };
            seen.ghToken = options.env?.GH_TOKEN;
            if (args[0] === 'pr') return pr ? { exitCode: 0, stdout: JSON.stringify(pr), stderr: '' } : { exitCode: 1, stdout: '', stderr: 'no pull requests found for branch "feature"' };
            if (args[1].endsWith('/reviews')) return { exitCode: 0, stdout: JSON.stringify(REVIEWS), stderr: '' };
            if (args[1].endsWith('/comments')) return { exitCode: 0, stdout: JSON.stringify(INLINE), stderr: '' };
            return { exitCode: 1, stdout: '', stderr: 'unexpected gh call' };
        }
        const binary = path.basename(command).replace(/\.(cmd|exe)$/, '');
        if (args[0] === '--version') return (seen.installed ?? ['claude', 'cursor-agent']).includes(binary) ? { exitCode: 0, stdout: `${seen.versions?.[command] ?? '1.0.0'}\n`, stderr: '' } : { exitCode: 127, stdout: '', stderr: 'not found' };
        seen.ran.push(command);
        const name = binary === 'claude' ? 'claude' : binary === 'cursor-agent' ? 'cursor' : 'codex';
        const prompt = binary === 'cursor-agent' ? args[args.length - 1] : args[args.indexOf('-p') + 1];
        seen.prompts.push(prompt);
        // Paths as the prompt names them, on either separator (Windows writes `D:\...`).
        for (const match of prompt.matchAll(/(\S+(?:previous-reviews\.md|pr-description\.md|full\.diff|hints\.txt|previous-open\.json|delta\.diff|previous-resolved\.json))/g)) {
            seen.files[path.basename(match[1])] = fs.readFileSync(match[1], 'utf8');
        }
        const reply = answer(name);
        if (typeof reply !== 'string') return reply;
        return { exitCode: 0, stdout: binary === 'claude' ? JSON.stringify({ result: reply, total_cost_usd: 1.5 }) : JSON.stringify({ result: reply }), stderr: '' };
    };
}

const seenNow = (): Seen => ({ prompts: [], files: {}, ghArgs: [], ran: [] });

/** A PATH of our own, so the test sees only the agent CLIs it creates (the fake exec answers for them by name). */
let bins: string[];
const originalPath = process.env.PATH;
function installFake(dir: string, name: string): string {
    const file = path.join(dir, process.platform === 'win32' ? `${name}.cmd` : name);
    fs.writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    return file;
}

beforeEach(() => {
    bins = [fs.mkdtempSync(path.join(os.tmpdir(), 'bin-a-')), fs.mkdtempSync(path.join(os.tmpdir(), 'bin-b-'))];
    for (const name of ['claude', 'cursor-agent']) installFake(bins[0], name);
    process.env.PATH = [...bins, originalPath ?? ''].join(path.delimiter);
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewer-'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 't');
    git('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1;\n');
    git('add', '-A');
    git('commit', '-qm', 'init');
    git('checkout', '-qb', 'feature');
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(path.join(repo, 'src/job.ts'), 'export function job() {\n    return 1;\n}\n');
    git('add', '-A');
    git('commit', '-qm', 'job');
});
afterEach(() => {
    process.env.PATH = originalPath;
    for (const dir of [repo, ...bins]) fs.rmSync(dir, { recursive: true, force: true });
});

describe('the reviewer', () => {
    it('works from every human review with inline comments and the description, written to files, and blocks on an open point', async () => {
        const seen = seenNow();
        const answer = JSON.stringify({ ...EMPTY, prior_points: [{ point: 'lock before read', severity: 'blocking', resolved: false, evidence: 'src/job.ts:2' }] });
        const result = await runReviewer(repo, 'main', config, fakes(() => answer, seen), () => undefined);
        expect(seen.files['previous-reviews.md']).toContain('Review by senior');
        expect(seen.files['previous-reviews.md']).toContain('- 2026-10-03 src/job.ts:12: Check the lock before the first read.');
        expect(seen.files['previous-reviews.md']).not.toContain('automated');
        expect(seen.files['previous-reviews.md']).not.toContain('self note');
        expect(seen.files['pr-description.md']).toBe('Every read is bounded at both ends.');
        expect(seen.files['full.diff']).toContain('+export function job()');
        expect(seen.ghToken).toBe('token-for-account');
        expect(seen.ghArgs[1].slice(0, 3)).toEqual(['pr', 'view', 'feature']); // by branch: the commit is not on the forge yet
        expect(result).toMatchObject({ outcome: 'findings', reviewers: ['claude'], scope: 'full', cached: false, previousReview: 'senior, 2026-10-03 (1 review)', pr: 42, costUsd: 1.5 });
        expect(result.items).toEqual([expect.objectContaining({ kind: 'prior', issue: 'lock before read', evidence: 'src/job.ts:2', reviewer: 'claude' })]);
        expect(reviewerBlocks(result)).toBe(true);
    });

    it('caches the verdict per commit and inputs, so the same push is free, and the next commit gets a delta review that carries what is not accounted for', async () => {
        const seen = seenNow();
        const open = JSON.stringify({ ...EMPTY, findings: [{ class: 'correctness', file: 'src/job.ts', line: 2, issue: 'returns before the lock', why: 'x' }] });
        const first = await runReviewer(repo, 'main', config, fakes(() => open, seen), () => undefined);
        expect(first.items).toHaveLength(1);
        const again = await runReviewer(repo, 'main', config, fakes(() => open, seen), () => undefined);
        expect(again.cached).toBe(true);
        expect(seen.prompts).toHaveLength(1);
        expect(fs.readdirSync(repo).sort()).toEqual(['.git', 'a.ts', 'src']); // nothing written to the working tree

        fs.writeFileSync(path.join(repo, 'src/job.ts'), 'export function job() {\n    return 2;\n}\n');
        git('commit', '-qam', 'tweak');
        const delta = await runReviewer(repo, 'main', config, fakes(() => JSON.stringify({ ...EMPTY, prior_points: [], carried: [], resolved_previous: [] }), seen), () => undefined);
        expect(delta.scope).toBe('delta');
        expect(seen.prompts[1]).toContain('DELTA MODE');
        expect(seen.files['delta.diff']).toContain('-    return 1;');
        expect(JSON.parse(seen.files['previous-open.json'])).toHaveLength(1);
        expect(delta.items).toEqual([expect.objectContaining({ issue: 'returns before the lock', status: 'not accounted for' })]);
        expect(delta.outcome).toBe('findings');
        // The human point the previous verdict resolved (a.ts untouched) was carried, not judged again.
        expect(JSON.parse(seen.files['previous-resolved.json'])).toEqual([expect.objectContaining({ point: 'lock before read', resolved: true })]);
        expect(delta.answerInReply).toEqual([]);
    });

    it('resolves a previous item only with evidence, and never blocks on an item that names code the checkout does not have', async () => {
        const seen = seenNow();
        const first = await runReviewer(repo, 'main', config, fakes(() => JSON.stringify({ ...EMPTY, findings: [{ class: 'correctness', file: 'src/job.ts', line: 2, issue: 'returns before the lock' }, { class: 'dead-code', file: 'src/ghost.ts', line: 1, issue: 'unused' }, { class: 'dead-code', file: '', issue: 'somewhere, no file named' }] }), seen), () => undefined);
        expect(first.items.map(i => i.file)).toEqual(['src/job.ts']);
        expect(first.unverified.map(i => i.file)).toEqual(['src/ghost.ts', '']); // a slip and a finding with no place to check: shown, never a block
        const id = first.items[0].id;
        fs.writeFileSync(path.join(repo, 'src/job.ts'), 'export function job() {\n    return 2;\n}\n');
        git('commit', '-qam', 'fix');
        const delta = await runReviewer(repo, 'main', config, fakes(() => JSON.stringify({ ...EMPTY, prior_points: [], resolved_previous: [{ id, evidence: 'src/job.ts:2 the lock comes first now' }] }), seen), () => undefined);
        expect(delta.outcome).toBe('passed');
        expect(delta.resolved).toEqual([{ item: expect.objectContaining({ id }), evidence: 'src/job.ts:2 the lock comes first now' }]);
    });

    it('at push, asks a model only when someone will read the push: an open, non-draft pull request', async () => {
        const seen = seenNow();
        const none = await runReviewer(repo, 'main', config, fakes(() => JSON.stringify(EMPTY), seen, null), () => undefined, { trigger: 'push' });
        expect(none).toMatchObject({ outcome: 'skipped', reason: expect.stringContaining('no pull request for feature') });
        expect(reviewerBlocks(none)).toBe(false);
        expect(seen.prompts).toHaveLength(0);
        const draft = await runReviewer(repo, 'main', config, fakes(() => JSON.stringify(EMPTY), seen, { ...PR, isDraft: true }), () => undefined, { trigger: 'push' });
        expect(draft.reason).toContain('is a draft');
        const asked = await runReviewer(repo, 'main', config, fakes(() => JSON.stringify(EMPTY), seen, null), () => undefined, { trigger: 'review' });
        expect(asked.outcome).toBe('passed'); // on request it reviews without a pull request
        expect(seen.prompts).toHaveLength(1);
    });

    it('for a backtest, reads the named pull request and hides every review and comment from the reviewed moment on', async () => {
        const seen = seenNow();
        const hidden = await runReviewer(repo, 'main', config, fakes(() => JSON.stringify({ ...EMPTY, prior_points: [] }), seen), () => undefined, { pr: 42, reviewsBefore: '2026-10-03', force: true });
        expect(seen.ghArgs.find(a => a[0] === 'pr')?.slice(0, 3)).toEqual(['pr', 'view', '42']);
        expect(seen.files['previous-reviews.md']).toBe('none\n');
        expect(hidden.outcome).toBe('passed');
        const shown = await runReviewer(repo, 'main', config, fakes(() => JSON.stringify({ ...EMPTY, prior_points: [] }), seen), () => undefined, { pr: 42, reviewsBefore: '2026-10-04', force: true });
        expect(seen.files['previous-reviews.md']).toContain('Review by senior');
        expect(shown).toMatchObject({ outcome: 'unavailable', reason: 'claude did not report on the human reviews' });
    });

    it('never passes without a verdict: a crash, a malformed answer, an unreadable pull request or no installed reviewer', async () => {
        const crashed = await runReviewer(repo, 'main', config, fakes(() => ({ exitCode: 1, stdout: '', stderr: 'API error' }), seenNow()), () => undefined);
        expect(crashed).toMatchObject({ outcome: 'unavailable', reason: expect.stringContaining('claude: no answer (exit 1)') });
        const prose = await runReviewer(repo, 'main', config, fakes(() => 'Looks good to me!', seenNow()), () => undefined);
        expect(prose).toMatchObject({ outcome: 'unavailable', reason: expect.stringContaining('no valid verdict') });
        const broken: Exec = async (command, args, options) => command === 'gh' && args[0] === 'pr' ? { exitCode: 1, stdout: '', stderr: 'HTTP 500' } : fakes(() => '', seenNow())(command, args, options);
        expect(await runReviewer(repo, 'main', config, broken, () => undefined)).toMatchObject({ outcome: 'unavailable', reason: expect.stringContaining('could not read the pull request') });
        const seen = { ...seenNow(), installed: [] };
        expect(await runReviewer(repo, 'main', config, fakes(() => '', seen), () => undefined)).toMatchObject({ outcome: 'unavailable', reason: expect.stringContaining('no reviewer installed') });
        for (const result of [crashed, prose]) expect(reviewerBlocks(result as ReviewerResult)).toBe(true);
    });

    it('in full mode runs two vendors and resolves a human point only when both say so', async () => {
        const seen = seenNow();
        const by = (name: string) => JSON.stringify({ ...EMPTY, prior_points: [{ point: 'lock before read', severity: 'blocking', resolved: name === 'claude', evidence: 'src/job.ts:2' }], findings: name === 'cursor' ? [{ class: 'dead-code', file: 'a.ts', line: 1, issue: 'a is unused' }] : [] });
        const result = await runReviewer(repo, 'main', config, fakes(by, seen), () => undefined, { full: true });
        expect(result.reviewers).toEqual(['claude', 'cursor']);
        expect(result.items.map(i => [i.kind, i.reviewer])).toEqual([['prior', 'cursor'], ['finding', 'cursor']]);
        expect(seen.prompts).toHaveLength(2);
    });
});

describe('choosing reviewers', () => {
    it('runs the newest installed copy of a CLI, not the first on PATH', async () => {
        const seen = seenNow();
        const older = installFake(bins[0], 'claude');
        const newer = installFake(bins[1], 'claude');
        seen.versions = { [older]: '2.0.34 (Claude Code)', [newer]: '2.1.289 (Claude Code)' };
        const result = await runReviewer(repo, 'main', config, fakes(() => JSON.stringify(EMPTY), seen), () => undefined);
        expect(result.outcome).toBe('passed');
        expect(seen.ran).toEqual([newer]);
    });

    it('reads the vendors on the trailers, prefers another one in cross mode, and pairs two vendors in full mode', () => {
        const authors = vendorsOf('Claude Opus <noreply@example.com>\n');
        expect([...authors]).toEqual(['anthropic']);
        const installed = new Set(['claude', 'cursor', 'codex'] as const);
        expect(selectReviewers(['claude', 'cursor', 'codex'], 'single', authors, installed)).toEqual(['claude']);
        expect(selectReviewers(['claude', 'cursor', 'codex'], 'cross', authors, installed)).toEqual(['cursor']);
        expect(selectReviewers(['claude', 'cursor', 'codex'], 'full', authors, installed)).toEqual(['cursor', 'claude']);
        expect(selectReviewers(['claude', 'cursor'], 'cross', authors, new Set(['claude'] as const))).toEqual(['claude']); // falls back to what is installed
        expect(selectReviewers(['claude'], 'full', new Set(), new Set())).toEqual([]);
    });
});

describe('verdicts', () => {
    it('finds the verdict when the reviewer wraps it in a summary or a code fence, and refuses prose', () => {
        const verdict = JSON.stringify(EMPTY);
        for (const text of [`## Summary\nAll checked.\n\n\`\`\`json\n${verdict}\n\`\`\`\nDone.`, `Notes first.\n${verdict}\nThat is all {see above}.`]) {
            expect(parseVerdict(text, true, 'claude', undefined)).toMatchObject({ verdict: { prior_points: [{ point: 'lock before read' }], reviewer: 'claude' } });
        }
        expect(parseVerdict('Looks good to me!', false, 'claude', undefined)).toMatchObject({ error: expect.stringContaining('no valid verdict') });
        expect(parseVerdict(JSON.stringify({ ...EMPTY, prior_points: [] }), true, 'claude', undefined)).toEqual({ error: 'claude did not report on the human reviews' });
    });

    it('turns reads, scans, redundancy and merge impact into open items with stable ids, and answers non-blocking points in the reply', () => {
        const verdict: Verdict = {
            ...EMPTY,
            prior_points: [{ point: 'nit: rename', severity: 'non-blocking', resolved: false }],
            reads: [{ file: 'src/q.ts', line: 10, read: 'select attempts', rules: [{ rule: 'flag off', known_before_read: true, applied_before_read: false }], narrower_source: 'attempt.updated_at', keys: [{ name: 'eventId', inputs: 'answered_at', stable_under_edit: false }], window_bounded: false, keyset: null }],
            scans: [{ file: 'src/s.ts', line: 3, function: 'later', outer: 'attempts', inner: 'answers', fix: 'index by attempt' }],
            redundant: [{ file: 'src/r.ts', line: 5, what: 'null guard', made_redundant_by: 'src/r.ts:2', removed: false }, { file: 'src/r.ts', line: 9, what: 'removed guard', removed: true }],
            merge_impact: [{ symbol: 'parseId', main_file: 'src/id.ts', call_site: 'src/link.ts:4', holds: false, why: 'band dropped' }],
        };
        const { open, answerInReply } = account(verdict, undefined, () => true);
        expect(open.map(i => `${i.class} ${i.file}:${i.line}`)).toEqual([
            'dead-code src/r.ts:5', 'production-cost src/q.ts:10', 'production-cost src/q.ts:10', 'production-cost src/q.ts:10', 'correctness src/q.ts:10', 'production-cost src/s.ts:3', 'correctness src/link.ts:4',
        ]);
        expect(new Set(open.map(i => i.id)).size).toBe(open.length);
        expect(account(verdict, undefined, () => true).open.map(i => i.id)).toEqual(open.map(i => i.id)); // stable
        expect(answerInReply).toEqual([expect.objectContaining({ point: 'nit: rename' })]);
    });

    it('merges two verdicts: a point is resolved only when every reviewer resolves it', () => {
        const a: Verdict = { ...EMPTY, reviewer: 'claude', prior_points: [{ point: 'Lock before read', severity: 'blocking', resolved: true }], resolved_previous: [{ id: 'x', evidence: 'e' }, { id: 'y', evidence: 'e' }] };
        const b: Verdict = { ...EMPTY, reviewer: 'cursor', prior_points: [{ point: 'lock before read.', severity: 'blocking', resolved: false }], resolved_previous: [{ id: 'x', evidence: 'e' }] };
        const merged = mergeVerdicts([a, b]);
        expect(merged.prior_points).toEqual([expect.objectContaining({ resolved: false, reviewer: 'cursor' })]);
        expect(merged.resolved_previous.map(r => r.id)).toEqual(['x']);
        expect(merged.reviewers?.map(r => r.reviewer)).toEqual(['claude', 'cursor']);
    });

    it('carries a resolved human point into a delta verdict unless the new commits touch its evidence', () => {
        const previous: Verdict = { ...EMPTY, prior_points: [{ point: 'lock before read', resolved: true, evidence: 'src/job.ts:2' }, { point: 'rename it', resolved: true, evidence: 'src/name.ts:9' }] };
        const fresh: Verdict = { ...EMPTY, prior_points: [] };
        expect(carryResolved(fresh, previous, new Set(['src/name.ts'])).prior_points.map(p => p.point)).toEqual(['lock before read']);
        expect(carryResolved({ ...EMPTY, prior_points: [{ point: 'Lock before read', resolved: false }] }, previous, new Set()).prior_points).toHaveLength(2);
    });
});
