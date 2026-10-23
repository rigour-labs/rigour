/**
 * Fake agent CLIs on PATH, for tests that run the reviewer through real processes: each records its argv, working
 * directory, environment and pid, and answers what the test asks (an answer, a crash, a hang, a scratch file written in
 * its working directory). Plus a real git repository whose commits have fixed dates, so their shas never change.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

export interface JudgeRun { name: string; argv: string[]; cwd: string; env: Record<string, string>; pid: number; prompt: string; files: string[] }
export interface Behaviour { answer?: string; exitCode?: number; sleepMs?: number; scratch?: { file: string; content: string } }

const SCRIPT = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const dir = __dirname;
const name = path.basename(process.argv[1]);
const argv = process.argv.slice(2);
const versions = JSON.parse(fs.readFileSync(path.join(dir, 'versions.json'), 'utf8'));
if (argv[0] === '--version') { process.stdout.write(versions[name] + '\\n'); process.exit(0); }
const b = JSON.parse(fs.readFileSync(path.join(dir, 'behaviour.json'), 'utf8'));
const prompt = name === 'claude' ? argv[argv.indexOf('-p') + 1] : argv[argv.length - 1];
if (b.scratch) { fs.mkdirSync(path.dirname(b.scratch.file), { recursive: true }); fs.writeFileSync(b.scratch.file, b.scratch.content); }
fs.appendFileSync(path.join(dir, 'runs.jsonl'), JSON.stringify({ name, argv, cwd: process.cwd(), env: process.env, pid: process.pid, prompt, files: fs.readdirSync('.') }) + '\\n');
const answer = b.answer || '';
const out = name === 'claude' ? JSON.stringify({ type: 'result', result: answer, total_cost_usd: 0.01 })
    : name === 'codex' ? JSON.stringify({ type: 'item.completed', item: { text: answer } }) + '\\n' + JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } })
    : JSON.stringify({ result: answer });
setTimeout(() => { process.stdout.write(out + '\\n'); process.exit(b.exitCode || 0); }, b.sleepMs || 0);
`;

export interface FakeJudges { dir: string; runs(): JudgeRun[]; behave(b: Behaviour): void; remove(): void }

/** Installs fake claude, codex and cursor-agent first on PATH (newer than any real copy, so they are the ones run). */
export function installFakeJudges(): FakeJudges {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-judges-'));
    fs.writeFileSync(path.join(dir, 'versions.json'), JSON.stringify({ claude: '9999.0.0 (Claude Code)', codex: 'codex-cli 9999.0.0', 'cursor-agent': '9999.0.0' }));
    for (const name of ['claude', 'codex', 'cursor-agent']) fs.writeFileSync(path.join(dir, name), SCRIPT, { mode: 0o755 });
    const originalPath = process.env.PATH;
    process.env.PATH = [dir, originalPath ?? ''].join(path.delimiter);
    const runsFile = path.join(dir, 'runs.jsonl');
    const judges: FakeJudges = {
        dir,
        runs: () => (fs.existsSync(runsFile) ? fs.readFileSync(runsFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []),
        behave: b => fs.writeFileSync(path.join(dir, 'behaviour.json'), JSON.stringify(b)),
        remove: () => {
            process.env.PATH = originalPath;
            fs.rmSync(dir, { recursive: true, force: true });
        },
    };
    judges.behave({ answer: JSON.stringify(EMPTY_VERDICT) });
    return judges;
}

export const EMPTY_VERDICT = { prior_points: [], redundant: [], reads: [], scans: [], merge_impact: [], findings: [], carried: [], resolved_previous: [] };

const FIXED = { GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' };

/** Real git in `repo`, every commit at the same fixed date. */
export function gitIn(repo: string, ...args: string[]): string {
    return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: { ...process.env, ...FIXED } }).trim();
}

/** A repository with `main` (a.ts, plus `onMain`) and a `feature` branch adding src/job.ts (plus `onFeature`), checked out. */
export function makeRepo(onMain: Record<string, string> = {}, onFeature: Record<string, string> = {}): string {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-switches-'));
    gitIn(repo, 'init', '-q', '-b', 'main');
    for (const [key, value] of [['user.email', 'dev-a@example.com'], ['user.name', 'dev-a'], ['commit.gpgsign', 'false'], ['gc.auto', '0']]) gitIn(repo, 'config', key, value);
    write(repo, { 'a.ts': 'export const a = 1;\n', ...onMain });
    gitIn(repo, 'add', '-A');
    gitIn(repo, 'commit', '-qm', 'init');
    gitIn(repo, 'checkout', '-qb', 'feature');
    write(repo, { 'src/job.ts': 'export function job() {\n    return 1;\n}\n', ...onFeature });
    gitIn(repo, 'add', '-A');
    gitIn(repo, 'commit', '-qm', 'job');
    return repo;
}

export function write(repo: string, files: Record<string, string>): void {
    for (const [file, text] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
        fs.writeFileSync(path.join(repo, file), text);
    }
}

/** A prompt with this machine's paths taken out: the repository and Rigour's input folder. */
export function portable(prompt: string, repo: string): string {
    return prompt.split(fs.realpathSync(repo)).join('<repo>').split(repo).join('<repo>').replace(/\S*rigour-reviewer-[A-Za-z0-9]+/g, '<work>');
}

/** About 2,800 characters in each of `files` new files: over a one-minute judge's limit, so the orchestrator would split it. */
export function bigChange(repo: string, files = 24): void {
    for (let f = 0; f < files; f++) {
        write(repo, { [`src/load${f}.ts`]: `${Array.from({ length: 30 }, (_, i) => `export async function load${f}x${i}(db) { return db.query('select * from orders${f} where id = ${i}'); }`).join('\n')}\n` });
    }
    gitIn(repo, 'add', '-A');
    gitIn(repo, 'commit', '-qm', 'big');
}
