/**
 * Differential tests: call each changed exported function on the same inputs
 * before and after the change, and report where its behaviour changed.
 *
 * Many bugs reviewers miss only show up when the code runs: an encoder that
 * stopped escaping spaces, a status that no longer reaches `notFound`. The
 * model proposes edge-case calls (validated to be literal-only), Rigour writes
 * a recording test, runs it in a worktree of the base and in the head tree,
 * and compares. A change the PR description says is intended is dropped.
 *
 * Opt-in (`rigour review --diff-tests`), for the max and cloud tiers, and only
 * where the package already runs vitest or jest.
 */
import { execa } from 'execa';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { evaluateTypedCommand } from '../../firewall/typed-command.js';
import type { InferenceOptions, InferenceProvider } from '../../inference/types.js';
import { loadProjectConfig, programBatches } from '../../semantic/program.js';
import { ProjectFacts } from '../../semantic/project-facts.js';
import { changedFunctions, functionName, isExported } from '../changed-functions.js';
import { safeCalls, testFileSource, type Runner } from './calls.js';

export interface DiffTestInput {
    cwd: string;
    /** The ref the change is compared against (a merge base, or HEAD for working changes). */
    baseRef: string;
    focusLines: Record<string, number[]>;
    provider: InferenceProvider;
    inference: InferenceOptions;
    prBody?: string;
    timeoutMs?: number;
}

export interface BehaviourChange {
    file: string;
    /** A changed line inside the function, so the finding lands on the change. */
    line: number;
    name: string;
    call: string;
    before: string;
    after: string;
}

interface Target {
    file: string;
    line: number;
    name: string;
    source: string;
    runner: Runner;
    packageDir: string;
}

const MAX_TARGETS = 5;
const TS_FILE = /\.(?:[cm]?ts|tsx)$/i;
const CALLS_SCHEMA = { type: 'object', properties: { calls: { type: 'array', items: { type: 'string' } } }, required: ['calls'] };
const INTENT_SCHEMA = { type: 'object', properties: { intended: { type: 'boolean' } }, required: ['intended'] };

export async function runDiffTests(input: DiffTestInput): Promise<BehaviourChange[]> {
    const targets = findTargets(input.cwd, input.focusLines);
    if (targets.length === 0) return [];
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rigour-diff-base-'));
    try {
        await execa('git', ['worktree', 'add', '-q', '--detach', base, input.baseRef], { cwd: input.cwd });
        linkDependencies(input.cwd, base);
        const changes: BehaviourChange[] = [];
        for (const target of targets) {
            if (!fs.existsSync(path.join(base, target.file))) continue; // a new file has no "before"
            const calls = await proposeCalls(input, target);
            if (calls.length === 0) continue;
            const before = await record(base, input.cwd, target, calls, input.timeoutMs);
            const after = await record(input.cwd, input.cwd, target, calls, input.timeoutMs);
            for (const call of calls) {
                if (before[call] !== undefined && after[call] !== undefined && before[call] !== after[call]) {
                    changes.push({ file: target.file, line: target.line, name: target.name, call, before: before[call], after: after[call] });
                }
            }
        }
        return input.prBody ? await dropIntended(input, changes) : changes;
    } finally {
        await execa('git', ['worktree', 'remove', '--force', base], { cwd: input.cwd, reject: false });
        fs.rmSync(base, { recursive: true, force: true });
    }
}

/** Changed exported functions in TS files of packages that run vitest or jest. */
function findTargets(cwd: string, focusLines: Record<string, number[]>): Target[] {
    const facts = new ProjectFacts(cwd);
    const targets: Target[] = [];
    const files = Object.keys(focusLines).filter(f => TS_FILE.test(f) && !/\.(?:test|spec)\./.test(f) && focusLines[f].length > 0);
    const options = loadProjectConfig(cwd).options;
    for (const file of files) {
        const runner: Runner | undefined = facts.declares(file, 'vitest') ? 'vitest' : facts.declares(file, 'jest') ? 'jest' : undefined;
        const packageDir = facts.packageDir(file);
        if (!runner || !packageDir) continue;
        const absolute = path.resolve(cwd, file);
        const [program] = programBatches([absolute], options, 1);
        const sourceFile = program?.getSourceFile(absolute);
        if (!program || !sourceFile) continue;
        program.getTypeChecker(); // binds the program: export checks walk parent pointers
        for (const fn of changedFunctions(sourceFile, focusLines[file]).filter(isExported)) {
            const name = functionName(fn);
            const start = sourceFile.getLineAndCharacterOfPosition(fn.getStart(sourceFile)).line + 1;
            const end = sourceFile.getLineAndCharacterOfPosition(fn.getEnd()).line + 1;
            const line = focusLines[file].find(l => l >= start && l <= end);
            if (name && line) targets.push({ file, line, name, source: fn.getText(sourceFile), runner, packageDir });
            if (targets.length >= MAX_TARGETS) return targets;
        }
    }
    return targets;
}

async function proposeCalls(input: DiffTestInput, target: Target): Promise<string[]> {
    const prompt = [
        `Propose up to 8 calls of \`${target.name}\` that probe its edge cases: empty, boundary, unusual characters, missing optional fields.`,
        'Use literal arguments only (strings, numbers, booleans, null, undefined, arrays and objects of those). No variables, no other functions.',
        `FUNCTION (${target.file}):\n${target.source}`,
        input.prBody ? `THE CHANGE INTENDS:\n${input.prBody.slice(0, 1000)}` : '',
        `Respond ONLY with JSON: {"calls": ["${target.name}(...)", ...]}`,
    ].filter(Boolean).join('\n\n');
    try {
        const reply = await input.provider.analyze(prompt, { ...input.inference, jsonSchema: CALLS_SCHEMA });
        const parsed = JSON.parse(reply.slice(reply.indexOf('{'), reply.lastIndexOf('}') + 1));
        return safeCalls(target.name, Array.isArray(parsed.calls) ? parsed.calls.map(String) : []);
    } catch {
        return [];
    }
}

/**
 * Run the recording test in `root` (the base worktree or the head tree, `head`
 * being where the target was found) and return each call's outcome; empty when
 * the run fails.
 */
async function record(root: string, head: string, target: Target, calls: string[], timeoutMs = 120_000): Promise<Record<string, string>> {
    const testFile = path.join(root, path.dirname(target.file), `__rigour_diff_${target.name}.test.ts`);
    const outFile = path.join(os.tmpdir(), `rigour-diff-${process.pid}-${Date.now()}.json`);
    const importPath = `./${path.basename(target.file).replace(/\.(?:[cm]?ts|tsx)$/, '')}`;
    const packageDir = path.join(root, path.relative(head, target.packageDir));
    fs.writeFileSync(testFile, testFileSource(target.runner, target.name, importPath, calls));
    try {
        const runner = installedRunner(packageDir, root, target.runner);
        const command = runner && `${runner} ${target.runner === 'vitest' ? 'run ' : ''}${path.relative(packageDir, testFile)}`;
        if (!command || evaluateTypedCommand(command).decision !== 'allow') return {};
        const [bin, ...args] = command.split(' ');
        await execa(bin, args, { cwd: packageDir, env: { ...process.env, RIGOUR_DIFF_OUT: outFile, CI: '1' }, timeout: timeoutMs, reject: false });
        return fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : {};
    } finally {
        fs.rmSync(testFile, { force: true });
        fs.rmSync(outFile, { force: true });
    }
}

/** The package's own installed runner, never a download: node_modules/.bin up to the repository root. */
function installedRunner(packageDir: string, root: string, runner: Runner): string | undefined {
    for (let dir = packageDir; dir.startsWith(root); dir = path.dirname(dir)) {
        const bin = path.join(dir, 'node_modules', '.bin', runner);
        if (fs.existsSync(bin)) return bin;
        if (dir === root) break;
    }
    return undefined;
}

/** The base worktree has no installed packages: link the head's node_modules into it. */
function linkDependencies(head: string, base: string): void {
    const walk = (dir: string, depth: number): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const from = path.join(dir, entry.name);
            const to = path.join(base, path.relative(head, from));
            if (entry.name === 'node_modules') {
                // A linked node_modules (pnpm, a workspace) counts; its target is what the base needs.
                if (fs.existsSync(path.dirname(to)) && !fs.existsSync(to)) fs.symlinkSync(fs.realpathSync(from), to, 'dir');
            } else if (entry.isDirectory() && entry.name !== '.git' && depth < 3) {
                walk(from, depth + 1); // never through symlinks: no loops
            }
        }
    };
    walk(head, 0);
}

async function dropIntended(input: DiffTestInput, changes: BehaviourChange[]): Promise<BehaviourChange[]> {
    const kept: BehaviourChange[] = [];
    for (const change of changes) {
        const prompt = [
            `THE CHANGE INTENDS:\n${input.prBody!.slice(0, 1500)}`,
            `BEHAVIOUR CHANGED: ${change.call} ${change.before} before the change, and ${change.after} after it.`,
            'Is this behaviour change what the description asks for? Respond ONLY with JSON: {"intended": true|false}.',
        ].join('\n\n');
        try {
            const reply = await input.provider.analyze(prompt, { ...input.inference, jsonSchema: INTENT_SCHEMA });
            if (JSON.parse(reply.slice(reply.indexOf('{'), reply.lastIndexOf('}') + 1)).intended !== true) kept.push(change);
        } catch {
            kept.push(change);
        }
    }
    return kept;
}
