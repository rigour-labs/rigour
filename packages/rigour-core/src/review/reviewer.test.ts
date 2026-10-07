import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigSchema } from '../types/index.js';
import { reviewerBlocks, runReviewer, type Exec, type ReviewerResult } from './reviewer.js';
import { dismissReviewerFinding } from './reviewer/context.js';
import { reviewStatus } from './reviewer/background.js';
import { selectReviewers, vendorsOf } from './reviewer/adapters.js';
import { account, carryResolved, checkoutVerifier, mergeVerdicts, parseVerdict, type Verdict } from './reviewer/verdict.js';

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

interface Seen { prompts: string[]; files: Record<string, string>; ghArgs: string[][]; ran: string[]; args?: string[][]; unset?: Array<string[] | undefined>; ghToken?: string; installed?: string[]; versions?: Record<string, string> }

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
        (seen.args ??= []).push(args);
        (seen.unset ??= []).push(options.unset);
        const name = binary === 'claude' ? 'claude' : binary === 'cursor-agent' ? 'cursor' : 'codex';
        const prompt = binary === 'claude' ? args[args.indexOf('-p') + 1] : args[args.length - 1];
        seen.prompts.push(prompt);
        // Paths as the prompt names them, on either separator (Windows writes `D:\...`).
        for (const match of prompt.matchAll(/(\S+(?:previous-reviews\.md|pr-description\.md|full\.diff|hints\.txt|previous-open\.json|delta\.diff|previous-resolved\.json|team-knowledge\.md))/g)) {
            seen.files[path.basename(match[1])] = fs.readFileSync(match[1], 'utf8');
        }
        const reply = answer(name);
        if (typeof reply !== 'string') return reply;
        const stdout = binary === 'claude' ? JSON.stringify({ result: reply, total_cost_usd: 1.5 }) : binary === 'codex' ? JSON.stringify({ type: 'item.completed', item: { text: reply } }) : JSON.stringify({ result: reply });
        return { exitCode: 0, stdout, stderr: '' };
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
        const answer = JSON.stringify({ ...EMPTY, prior_points: [{ point: 'lock before read', severity: 'blocking', resolved: false, evidence: 'src/job.ts:2', file: 'src/job.ts', line: 2, quote: 'export function job() {' }] });
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
        const open = JSON.stringify({ ...EMPTY, findings: [{ class: 'correctness', file: 'src/job.ts', line: 2, issue: 'returns before the lock', quote: 'export function job() {', consequence: 'a second run reads stale rows', why: 'x' }] });
        const first = await runReviewer(repo, 'main', config, fakes(() => open, seen), () => undefined, { checks: ['src/job.ts:1 Unused export `job`'] });
        expect(first.items).toHaveLength(1);
        const again = await runReviewer(repo, 'main', config, fakes(() => open, seen), () => undefined, { checks: ['src/job.ts:1 Unused export `job`'] });
        expect(again.cached).toBe(true);
        expect(seen.prompts).toHaveLength(1);
        expect(fs.readdirSync(repo).sort()).toEqual(['.git', 'a.ts', 'src']); // nothing written to the working tree

        fs.writeFileSync(path.join(repo, 'src/job.ts'), 'export function job() {\n    return 2;\n}\n');
        git('commit', '-qam', 'tweak');
        // What the checks found changed with the commit: the context changes, the instructions do not, so it is still a delta.
        const delta = await runReviewer(repo, 'main', config, fakes(() => JSON.stringify({ ...EMPTY, prior_points: [], carried: [], resolved_previous: [] }), seen), () => undefined, { checks: ['src/job.ts:2 Unused export `other`'] });
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
        const first = await runReviewer(repo, 'main', config, fakes(() => JSON.stringify({ ...EMPTY, findings: [{ class: 'correctness', file: 'src/job.ts', line: 2, issue: 'returns before the lock', quote: 'export function job() {', consequence: 'a second run reads stale rows' }, { class: 'dead-code', file: 'src/ghost.ts', line: 1, issue: 'unused', consequence: 'a second run reads stale rows' }, { class: 'dead-code', file: '', issue: 'somewhere, no file named', consequence: 'a second run reads stale rows' }] }), seen), () => undefined);
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

    it('for a backtest, gives the description as it read at the review, never a later edit', async () => {
        const versions = { lastEditedAt: '2026-10-06T00:00:00Z', body: 'today: refunds are issued by the nightly job', userContentEdits: { totalCount: 3, nodes: [
            { editedAt: '2026-10-06T00:00:00Z', diff: 'today: refunds are issued by the nightly job' },
            { editedAt: '2026-10-02T00:00:00Z', diff: 'then: refunds are issued on request' },
            { editedAt: '2026-09-30T00:00:00Z', diff: 'first draft' },
        ] } };
        const withEdits = (answer: () => string, seen: ReturnType<typeof seenNow>, graphql: unknown): Exec => {
            const base = fakes(answer, seen);
            return async (command, args, options) => command === 'gh' && args[0] === 'api' && args[1] === 'graphql'
                ? { exitCode: graphql ? 0 : 1, stdout: JSON.stringify({ data: { repository: { pullRequest: graphql } } }), stderr: '' }
                : base(command, args, options);
        };
        const reply = () => JSON.stringify({ ...EMPTY, prior_points: [] });
        const seen = seenNow();
        await runReviewer(repo, 'main', config, withEdits(reply, seen, versions), () => undefined, { pr: 42, reviewsBefore: '2026-10-03T00:00:00Z', force: true });
        expect(seen.files['pr-description.md']).toBe('then: refunds are issued on request');
        await runReviewer(repo, 'main', config, withEdits(reply, seen, null), () => undefined, { pr: 42, reviewsBefore: '2026-10-03T00:00:00Z', force: true });
        expect(seen.files['pr-description.md']).toContain('could not be recovered');
    });

    it('blind, reviews the commit alone and never asks GitHub', async () => {
        const seen = seenNow();
        const result = await runReviewer(repo, 'main', config, fakes(() => JSON.stringify({ ...EMPTY, prior_points: [] }), seen), () => undefined, { blind: true, trigger: 'backtest', force: true });
        expect(result.outcome).toBe('passed');
        expect(seen.ghArgs).toEqual([]);
        expect(seen.files['previous-reviews.md']).toBe('none\n');
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

    it('keeps where each judge run spent its tokens and what it read, labelled, in the local verdict', async () => {
        const seen = seenNow();
        const base = fakes(() => JSON.stringify(EMPTY), seen);
        const streaming: Exec = async (command, args, options) => {
            if (!command.endsWith('claude') || args[0] === '--version') return base(command, args, options);
            const prompt = args[args.indexOf('-p') + 1];
            const diff = /(\S+full\.diff)/.exec(prompt)![1];
            const call = (id: string, name: string, input: object) => ({ type: 'assistant', message: { id: `m-${id}`, usage: { input_tokens: 1, cache_read_input_tokens: 100, cache_creation_input_tokens: 10, output_tokens: 5 }, content: [{ type: 'tool_use', id, name, input }] } });
            const events = [
                call('1', 'Read', { file_path: diff }), call('2', 'Read', { file_path: path.join(repo, 'src/job.ts') }), call('3', 'Read', { file_path: path.join(repo, 'a.ts') }),
                call('4', 'Bash', { command: 'git log -3' }), call('5', 'Grep', { pattern: 'job' }),
                { type: 'result', result: JSON.stringify(EMPTY), total_cost_usd: 0.2, usage: { input_tokens: 5, output_tokens: 25 } },
            ];
            return { exitCode: 0, stdout: events.map(e => JSON.stringify(e)).join('\n'), stderr: '' };
        };
        await runReviewer(repo, 'main', config, streaming, () => undefined, { force: true });
        const store = path.join(repo, '.git', 'rigour-reviewer');
        const verdict = fs.readdirSync(store).filter(f => /^[0-9a-f]{40}\.[0-9a-f]{8}\.json$/.test(f)).map(f => JSON.parse(fs.readFileSync(path.join(store, f), 'utf8')))[0];
        expect(verdict.reviewers[0].trace).toMatchObject({ turns: 5, usage: { input: 5, cacheRead: 500, cacheWrite: 50, output: 25 } });
        expect(verdict.reviewers[0].trace.calls.map((c: any) => c.category)).toEqual(['rigour-input', 'changed-file', 'other-file', 'git', 'search']);
    });

    it('asks a judge once more after an answer that is not a verdict, and is unavailable only when the second is not one either', async () => {
        const seen = seenNow();
        let calls = 0;
        const slipOnce = await runReviewer(repo, 'main', config, fakes(() => (++calls === 1 ? '{"prior_points":[], "findings":[{"class"' : JSON.stringify(EMPTY)), seen), () => undefined, { force: true });
        expect(slipOnce.outcome).toBe('passed');
        expect(seen.prompts).toHaveLength(2);
        const twice = seenNow();
        const slipTwice = await runReviewer(repo, 'main', config, fakes(() => 'not json', twice), () => undefined, { force: true });
        expect(slipTwice).toMatchObject({ outcome: 'unavailable', reason: expect.stringContaining('no valid verdict') });
        expect(twice.prompts).toHaveLength(2); // once more, never a loop
    });

    it('says what was asked and that nothing ran when a review ends early, with why a judge is missing', async () => {
        const seen = { ...seenNow(), installed: ['claude'] }; // cursor is listed but not installed
        const unreadable: Exec = async (command, args, options) => command === 'gh' && args[0] === 'pr' ? { exitCode: 1, stdout: '', stderr: 'gh auth login required' } : fakes(() => '', seen)(command, args, options);
        const result = await runReviewer(repo, 'main', config, unreadable, () => undefined, { choice: { mode: 'full', panel: true } });
        expect(result).toMatchObject({ outcome: 'unavailable', reviewers: ['claude'] });
        expect(result.mode).toMatchObject({ asked: 'panel', ran: 'none', source: 'flag', degraded: expect.stringContaining('not installed: cursor-agent') });

        const early = await runReviewer(repo, 'main', config, fakes(() => '', { ...seenNow(), installed: [] }), () => undefined, { choice: { mode: 'full', panel: true } });
        expect(early).toMatchObject({ outcome: 'unavailable', mode: { asked: 'panel', ran: 'none', source: 'flag' } }); // before any judge was found
    });

    it('in full mode runs two vendors and resolves a human point only when both say so', async () => {
        const seen = seenNow();
        const by = (name: string) => JSON.stringify({ ...EMPTY, prior_points: [{ point: 'lock before read', severity: 'blocking', resolved: name === 'claude', evidence: 'src/job.ts:2', file: 'src/job.ts', line: 2, quote: 'export function job() {' }], findings: name === 'cursor' ? [{ class: 'dead-code', file: 'a.ts', line: 1, issue: 'a is unused', consequence: 'a second run reads stale rows', quote: 'export const a = 1;' }] : [] });
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
            expect(parseVerdict(text, true, 'claude', {})).toMatchObject({ verdict: { prior_points: [{ point: 'lock before read' }], reviewer: 'claude' } });
        }
        expect(parseVerdict('Looks good to me!', false, 'claude', {})).toMatchObject({ error: expect.stringContaining('no valid verdict') });
        expect(parseVerdict(JSON.stringify({ ...EMPTY, prior_points: [] }), true, 'claude', {})).toEqual({ error: 'claude did not report on the human reviews' });
    });

    it('keeps the journey, sibling parity and claims as working notes, never blocks, and reads a verdict cached before they existed', () => {
        const verdict = {
            ...EMPTY,
            journey: [
                { file: 'src/w.ts', line: 4, what: 'stamps sent_at', cleared_by: null, retry_safe: false, overlap_safe: true, can_move_back: true, keys: [{ name: 'dedupeKey', inputs: 'updated_at', stable_under_edit: false }] },
                { file: 'src/w.ts', line: 9, what: 'caches the token', cleared_by: 'ttl', retry_safe: true, overlap_safe: true, can_move_back: null },
            ],
            siblings: [
                { changed: 'src/a/run.ts:3', sibling: 'src/b/run.ts:7', needs_same_change: true, has_it: false, why: 'same lock' },
                { changed: 'src/a/run.ts:3', sibling: 'src/c/run.ts:2', needs_same_change: true, has_it: true },
                { changed: 'src/a/run.ts:3', sibling: 'src/d/run.ts:2', needs_same_change: false, has_it: false },
            ],
            claims: [
                { source: 'description', claim: 'at worst one email', file: 'src/w.ts', line: 12, holds: false, evidence: 'loop sends per row' },
                { source: 'comment', claim: 'runs daily', file: 'src/cron.ts', line: 1, holds: true },
            ],
        };
        const { open, notes } = account(verdict as Verdict, undefined, () => true);
        expect(open).toEqual([]);
        expect(notes.map(i => `${i.kind} ${i.class} ${i.file}:${i.line}`)).toEqual([
            'journey correctness src/w.ts:4', 'journey correctness src/w.ts:4', 'journey correctness src/w.ts:4',
            'sibling correctness src/b/run.ts:7', 'claim stale-claim src/w.ts:12',
        ]);
        expect(notes[3].issue).toContain('needs the same change as src/a/run.ts:3: same lock');
        const cached = { ...EMPTY } as Partial<Verdict>;
        delete cached.journey; delete cached.siblings; delete cached.claims;
        expect(account(cached as Verdict, undefined, () => true).open).toEqual([]);
        expect(mergeVerdicts([cached as Verdict, { ...verdict, reviewer: 'codex' } as Verdict]).claims).toHaveLength(2);
    });

    it('blocks on a finding only when the code it quotes is at the line it names, and never carries an old working note as a block', () => {
        const verify = checkoutVerifier(repo);
        const at = (quote?: string, line = 2) => account({ ...EMPTY, prior_points: [], findings: [{ class: 'correctness', file: 'src/job.ts', line, issue: 'returns before the lock', input: 'two runs at once', consequence: 'two emails', ...(quote === undefined ? {} : { quote }) }] } as Verdict, undefined, verify);
        expect(at('    return 1;').open).toHaveLength(1);
        expect(at('return   1;').open).toHaveLength(1); // whitespace aside
        expect(at('return 1;', 9)).toMatchObject({ open: [], unverified: [expect.objectContaining({ issue: 'returns before the lock' })] }); // past the end
        expect(at('return 99;')).toMatchObject({ open: [], unverified: [expect.anything()] }); // not in the file
        expect(at()).toMatchObject({ open: [], unverified: [expect.anything()] }); // no quote at all
        const old = { id: 'r1', kind: 'read' as const, class: 'production-cost', file: 'src/q.ts', line: 3, issue: 'window not bounded' };
        const carried = account({ ...EMPTY, prior_points: [] } as Verdict, [old], verify);
        expect(carried).toMatchObject({ open: [], notes: [expect.objectContaining({ id: 'r1' })] });
    });

    it('shows a team lesson the change repeats as a note, never a block on its own', () => {
        const verdict = { ...EMPTY, lessons: [
            { lesson: 'Regenerate the API client after changing the schema.', applies: true, file: 'src/schema.ts', line: 3, evidence: 'schema.ts changed, client not' },
            { lesson: 'Paginate with keyset.', applies: false, file: 'src/scan.ts', line: 9 },
        ] } as unknown as Verdict;
        const { open, notes } = account(verdict, undefined, () => true);
        expect(open).toEqual([]);
        expect(notes.map(n => [n.kind, n.class, n.issue])).toEqual([['lesson', 'team-lesson', 'repeats a team lesson: Regenerate the API client after changing the schema.']]);
    });

    it('blocks only on what it can show: a quoted open human point, a blocking finding, never a missing thing that is there or a point a human accepted', () => {
        const verify = checkoutVerifier(repo);
        const decide = (v: Partial<Verdict>) => account({ ...EMPTY, prior_points: [], ...v } as Verdict, undefined, verify);
        const open = { point: 'take the lock before the first read', severity: 'blocking' as const, resolved: false };
        expect(decide({ prior_points: [{ ...open, file: 'src/job.ts', line: 2, quote: 'return 1;' }] }).open).toHaveLength(1);
        expect(decide({ prior_points: [open] })).toMatchObject({ open: [], unverified: [expect.objectContaining({ kind: 'prior' })] }); // a later commit may have done it: no quote, no block
        const finding = { class: 'correctness', file: 'src/job.ts', line: 2, issue: 'job never closes the connection', input: 'every run', consequence: 'one connection leaks per run', quote: 'return 1;' };
        expect(decide({ findings: [{ ...finding, absent: 'return 1' }] })).toMatchObject({ open: [], unverified: [expect.anything()] }); // "missing", but the file has it
        expect(decide({ findings: [{ ...finding, absent: 'conn.close(' }] }).open).toHaveLength(1);
        expect(decide({ findings: [{ ...finding, severity: 'should' }] })).toMatchObject({ open: [], notes: [expect.anything()] });
        const accepted = { point: 'job never closes the connection after the read', severity: 'non-blocking' as const, resolved: false };
        expect(decide({ prior_points: [accepted], findings: [finding] })).toMatchObject({ open: [], notes: [expect.anything()] }); // a human raised it and accepted it
    });

    it('keeps reads, scans, redundancy and merge impact as notes with stable ids, and answers non-blocking points in the reply', () => {
        const verdict: Verdict = {
            ...EMPTY,
            prior_points: [{ point: 'nit: rename', severity: 'non-blocking', resolved: false }],
            reads: [{ file: 'src/q.ts', line: 10, read: 'select attempts', rules: [{ rule: 'flag off', known_before_read: true, applied_before_read: false }], narrower_source: 'attempt.updated_at', keys: [{ name: 'eventId', inputs: 'answered_at', stable_under_edit: false }], window_bounded: false, keyset: null }],
            scans: [{ file: 'src/s.ts', line: 3, function: 'later', outer: 'attempts', inner: 'answers', fix: 'index by attempt' }],
            redundant: [{ file: 'src/r.ts', line: 5, what: 'null guard', made_redundant_by: 'src/r.ts:2', removed: false }, { file: 'src/r.ts', line: 9, what: 'removed guard', removed: true }],
            merge_impact: [{ symbol: 'parseId', main_file: 'src/id.ts', call_site: 'src/link.ts:4', holds: false, why: 'band dropped' }],
        };
        const { open, notes, answerInReply } = account(verdict, undefined, () => true);
        expect(open).toEqual([]);
        expect(notes.map(i => `${i.class} ${i.file}:${i.line}`)).toEqual([
            'dead-code src/r.ts:5', 'production-cost src/q.ts:10', 'production-cost src/q.ts:10', 'production-cost src/q.ts:10', 'correctness src/q.ts:10', 'production-cost src/s.ts:3', 'correctness src/link.ts:4',
        ]);
        expect(new Set(notes.map(i => i.id)).size).toBe(notes.length);
        expect(account(verdict, undefined, () => true).notes.map(i => i.id)).toEqual(notes.map(i => i.id)); // stable
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

describe('a panel of judges', () => {
    const panelConfig = (reviewer: Record<string, unknown>) => ConfigSchema.parse({ version: 1, review: { github_account: 'reviewer-account', reviewer: { enabled: true, reviewers: ['claude', 'cursor', 'codex'], mode: 'full', panel: 'on', ...reviewer } } });
    const LOCK = { class: 'correctness', file: 'src/job.ts', line: 2, issue: 'returns before the lock is taken', quote: 'export function job() {', consequence: 'two runs send the same email' };
    const LONE = { class: 'dead-code', file: 'src/job.ts', line: 1, issue: 'job is exported and never called', quote: 'export function job() {', consequence: 'a reader treats it as the contract' };
    const OPINION = { class: 'duplication', file: 'src/job.ts', line: 2, issue: 'could be one line shorter', quote: 'export function job() {', consequence: '' };

    it("keeps Rigour's own key from every judge, and a key the team names from that judge, in reviews and cross-examinations alike", async () => {
        installFake(bins[0], 'codex');
        const seen = { ...seenNow(), installed: ['claude', 'cursor-agent', 'codex'] };
        const reply = (name: string) => {
            const prompt = seen.prompts.at(-1) ?? '';
            if (prompt.includes('The other\nreviewer raised')) {
                const ids = [...prompt.matchAll(/"id": "([0-9a-f]+)"/g)].map(m => m[1]);
                return JSON.stringify({ answers: ids.map(id => ({ id, call: 'refute', evidence: `src/job.ts:1 ${name}: job is imported by the runner` })) });
            }
            return JSON.stringify({ ...EMPTY, findings: name === 'codex' ? [LONE] : [] });
        };
        await runReviewer(repo, 'main', panelConfig({ judges: 3, judge_env: { codex: { unset: ['OPENAI_API_KEY'] } } }), fakes(reply, seen), () => undefined);
        const runs = seen.ran.map((command, i) => ({ judge: path.basename(command).replace(/\.(cmd|exe)$/, ''), unset: seen.unset?.[i] ?? [] }));
        expect(runs.length).toBe(5); // three reviews and two cross-examinations
        for (const run of runs) expect(run.unset).toContain('RIGOUR_API_KEY');
        expect(runs.filter(r => r.unset.includes('OPENAI_API_KEY')).map(r => r.judge)).toEqual(['codex']);
    });

    it('confirms what a majority raised, drops what the others refute with evidence, and never blocks on an opinion', async () => {
        installFake(bins[0], 'codex');
        const seen = { ...seenNow(), installed: ['claude', 'cursor-agent', 'codex'] };
        const reply = (name: string) => {
            const prompt = seen.prompts.at(-1) ?? '';
            if (prompt.includes('The other\nreviewer raised')) {
                const ids = [...prompt.matchAll(/"id": "([0-9a-f]+)"/g)].map(m => m[1]);
                return JSON.stringify({ answers: ids.map(id => ({ id, call: 'refute', evidence: `src/job.ts:1 ${name}: job is imported by the runner` })) });
            }
            if (name === 'codex') return JSON.stringify({ ...EMPTY, findings: [LONE] });
            return JSON.stringify({ ...EMPTY, findings: name === 'claude' ? [LOCK, OPINION] : [{ ...LOCK, line: 3, issue: 'the lock is taken only after it returns' }] });
        };
        const result = await runReviewer(repo, 'main', panelConfig({ judges: 3, cross_models: { claude: 'claude-haiku-4-5' } }), fakes(reply, seen), () => undefined);
        expect(result.reviewers).toEqual(['claude', 'cursor', 'codex']);
        expect(result.mode).toMatchObject({ asked: 'panel', ran: 'panel', source: 'team' });
        expect(result.items.map(i => [i.issue, i.reviewer])).toEqual([[LOCK.issue, 'claude+cursor']]);
        expect(result.dropped.map(i => i.issue)).toEqual([LONE.issue]);
        expect(result.notes.map(i => i.issue)).toEqual([OPINION.issue]);
        expect(seen.prompts).toHaveLength(5); // three blind reviews, then claude and cursor each cross-examine codex's lone finding once
        expect(result.panel?.find(d => d.item.issue === LONE.issue)).toMatchObject({ judges: ['codex'], calls: { codex: 'raised', claude: 'refute', cursor: 'refute' }, status: 'dropped' });
        expect(result.costUsd).toBe(3); // claude's review and claude's cross-examination
        const claudeCalls = (seen.args ?? []).filter((_, i) => path.basename(seen.ran[i]).startsWith('claude'));
        expect(claudeCalls.map(a => a.includes('claude-haiku-4-5'))).toEqual([false, true]); // the cheaper model for the cross-examination only
    });

    it('runs one judge and says why when only one vendor is installed, and is unavailable when the team requires the panel', async () => {
        const seen = seenNow();
        const reply = () => JSON.stringify({ ...EMPTY, findings: [LOCK] });
        const fallback = await runReviewer(repo, 'main', panelConfig({ reviewers: ['claude', 'codex'] }), fakes(reply, seen), () => undefined);
        expect(fallback.mode).toMatchObject({ asked: 'panel', ran: 'single', degraded: expect.stringContaining('not installed: codex') });
        expect(fallback.items.map(i => i.issue)).toEqual([LOCK.issue]);
        const required = await runReviewer(repo, 'main', panelConfig({ reviewers: ['claude', 'codex'], panel: 'required' }), fakes(reply, seenNow()), () => undefined);
        expect(required.outcome).toBe('unavailable');
        expect(required.reason).toContain('rigour.yml requires two reviewers');
    });

    it('keeps to the daily caps: a review past the run cap is skipped, or unavailable when the team requires the reviewer', async () => {
        const reply = () => JSON.stringify({ ...EMPTY, findings: [LOCK] });
        const skipped = await runReviewer(repo, 'main', panelConfig({ max_runs_per_day: 1 }), fakes(reply, seenNow()), () => undefined);
        expect(skipped.outcome).toBe('skipped');
        expect(skipped.reason).toContain('the daily run cap is reached: 0 of 1 agent runs used today in this repository, and this needs 2 more');
        const required = await runReviewer(repo, 'main', panelConfig({ max_runs_per_day: 1, panel: 'required' }), fakes(reply, seenNow()), () => undefined);
        expect(required.outcome).toBe('unavailable');
    });

    it('counts every run, stops new reviews at the cost cap, and leaves a cross-examination past the run cap disputed', async () => {
        const seen = seenNow();
        const lone = { class: 'dead-code', file: 'src/job.ts', line: 1, issue: 'job is exported and never called', quote: 'export function job() {', consequence: 'a reader treats it as the contract' };
        const reply = (name: string) => JSON.stringify({ ...EMPTY, findings: name === 'claude' ? [LOCK] : [{ ...LOCK, line: 3, issue: 'the lock is taken only after it returns' }, lone] });
        // Two judges fit in a cap of 2; the cross-examination of cursor's lone finding would be a third run.
        const result = await runReviewer(repo, 'main', panelConfig({ max_runs_per_day: 2 }), fakes(reply, seen), () => undefined);
        expect(seen.prompts).toHaveLength(2);
        expect(result.items.map(i => i.issue)).toEqual([LOCK.issue]);
        expect(result.panel?.find(d => d.item.issue === lone.issue)).toMatchObject({ status: 'disputed', note: expect.stringContaining('the daily run cap is reached') });
        // claude reported $1.50: a cost cap of $1 lets no new review start today.
        const capped = await runReviewer(repo, 'main', panelConfig({ max_usd_per_day: 1 }), fakes(reply, seenNow()), () => undefined, { force: true });
        expect(capped).toMatchObject({ outcome: 'skipped', reason: expect.stringContaining('the daily cost cap is reached: $1.50 of $1.00') });
    });

    it('escalates on risk: one judge for a change with no risky function and no human review', async () => {
        const seen = seenNow();
        const result = await runReviewer(repo, 'main', panelConfig({ escalate: 'risk' }), fakes(() => JSON.stringify(EMPTY), seen, null), () => undefined);
        expect(result.mode).toMatchObject({ asked: 'panel', ran: 'single', escalation: expect.stringContaining('no risky changed function') });
        expect(seen.prompts).toHaveLength(1);
        const full = await runReviewer(repo, 'main', panelConfig({ escalate: 'risk' }), fakes(() => JSON.stringify(EMPTY), seenNow(), null), () => undefined, { full: true, force: true });
        expect(full.mode?.ran).toBe('panel'); // the --full hard stop always gets every judge
    });
});

describe('what the team already knows', () => {
    const allowing = ConfigSchema.parse({ version: 1, review: { github_account: 'reviewer-account', reviewer: { enabled: true, reviewers: ['claude', 'cursor'], dismissals: true } } });

    it('refuses a dismissal unless the team allows them: fix the code, or the reviewer', async () => {
        const first = await runReviewer(repo, 'main', allowing, fakes(() => JSON.stringify({ ...EMPTY, findings: [{ class: 'correctness', file: 'src/job.ts', line: 2, issue: 'returns before the lock is taken', quote: 'export function job() {', consequence: 'two runs send the same email' }] }), seenNow()), () => undefined);
        expect((await dismissReviewerFinding(repo, first.items[0].id, 'the runner holds a lock', false)).error).toContain('this team does not dismiss reviewer findings');
        expect(fs.existsSync(path.join(repo, '.rigour/dismissed-review-items.json'))).toBe(false);
    });

    it('a dismissed finding reaches the next judge as settled, and a re-worded repeat never blocks', async () => {
        fs.mkdirSync(path.join(repo, 'docs'));
        fs.writeFileSync(path.join(repo, 'docs/jobs.md'), 'The job runner (src/job.ts) takes the lock first.\n');
        git('add', '-A');
        git('commit', '-qm', 'docs');
        const finding = { class: 'correctness', file: 'src/job.ts', line: 2, issue: 'returns before the lock is taken', quote: 'export function job() {', consequence: 'two runs send the same email' };
        const first = await runReviewer(repo, 'main', allowing, fakes(() => JSON.stringify({ ...EMPTY, findings: [finding] }), seenNow()), () => undefined);
        expect(first.outcome).toBe('findings');
        expect(await dismissReviewerFinding(repo, 'abcdef0123', 'not one of ours', true)).toEqual({ error: 'no open reviewer finding abcdef0123 on feature: run `rigour review --reviewer` and copy the id it shows' });
        expect((await dismissReviewerFinding(repo, first.items[0].id, 'the runner holds a lock one level up', true)).item?.issue).toBe('returns before the lock is taken');
        expect((await reviewStatus(repo, 'feature'))?.last?.open).toEqual([]); // not work any more, right away

        const seen = seenNow();
        // The same commit again: no new run; the stored decision is reused, with the dismissal applied.
        const reused = await runReviewer(repo, 'main', allowing, fakes(() => JSON.stringify(EMPTY), seenNow()), () => undefined);
        expect(reused).toMatchObject({ cached: true, outcome: 'passed' });
        expect(reused.dismissed.map(i => i.issue)).toEqual(['returns before the lock is taken']);
        // A fresh review: the judge is told it is settled, and a re-worded repeat does not block either.
        const again = await runReviewer(repo, 'main', allowing, fakes(() => JSON.stringify({ ...EMPTY, findings: [{ ...finding, issue: 'returns before the lock is taken, so it races' }] }), seen), () => undefined, { force: true });
        expect(again.cached).toBe(false);
        expect(again.outcome).toBe('passed');
        expect(again.dismissed.map(i => i.issue)).toEqual(['returns before the lock is taken, so it races']);
        expect(seen.files['team-knowledge.md']).toContain('dismissed as not a bug by t@example.com: src/job.ts:2 [correctness] returns before the lock is taken (reason: the runner holds a lock one level up)');
        expect(seen.files['team-knowledge.md']).toContain('docs/jobs.md (names src/job.ts');
        const told = seenNow();
        await runReviewer(repo, 'main', allowing, fakes(() => JSON.stringify(EMPTY), told), () => undefined, { force: true, checks: ['src/job.ts:1 Unused export `job`'] });
        expect(told.files['team-knowledge.md']).toContain("## Already found by Rigour's checks: they block on their own, so do not report them again\n- src/job.ts:1 Unused export `job`");
    });

    it('fails closed: a finding whose judge left out the consequence still blocks', async () => {
        const result = await runReviewer(repo, 'main', config, fakes(() => JSON.stringify({ ...EMPTY, findings: [{ class: 'correctness', file: 'src/job.ts', line: 2, issue: 'returns before the lock', quote: 'export function job() {' }] }), seenNow()), () => undefined);
        expect(result.items.map(i => i.issue)).toEqual(['returns before the lock']);
        expect(result.notes).toEqual([]);
    });
});

