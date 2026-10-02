/**
 * `rigour learn`: from a fix (before and after trees) to validated rules.
 *
 * For each supported edit, candidates are tried from most general to most
 * specific. The first one that fires on the code before the fix, is silent on
 * the fixed code, and fires on at most `maxHits` places in the repository is
 * kept. Nothing is kept on a guess: an edit whose candidates all fail is
 * reported with the reason the most specific one failed.
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { globby } from 'globby';
import { analyzeFiles } from '../engine.js';
import { programBatches, loadProjectConfig } from '../program.js';
import { compileLearnedRule, LEARNED_PREFIX } from './compile.js';
import { extractEdits, type ProposedEdit, type TreeFile } from './extract.js';
import { endLineOf, forEachNode, lineOf } from '../ast.js';
import { functionKeyOf, isInvocation } from './identity.js';
import type { LearnedPattern, LearnedRule } from './types.js';

export interface LearnInput {
    beforeDir: string;
    afterDir: string;
    /** Repository the rules will guard; hits here are listed for review. */
    repoDir: string;
    /** Changed files, relative to both trees. */
    files: string[];
    commit?: string;
    maxHits?: number;
}

export interface Rejection {
    edit: ProposedEdit;
    reason: string;
}

export interface LearnReport {
    learned: LearnedRule[];
    rejected: Rejection[];
    unsupported: Array<{ file: string; fn: string }>;
}

const DEFAULT_MAX_HITS = 3;
const SOURCE = /\.(?:[cm]?[jt]s|[jt]sx)$/i;
const NOT_SOURCE = /\.d\.[cm]?ts$|(?:^|\/)(?:__tests__|__mocks__|tests?)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;

export async function learnFromFix(input: LearnInput): Promise<LearnReport> {
    const maxHits = input.maxHits ?? DEFAULT_MAX_HITS;
    const files = input.files.filter(f => SOURCE.test(f) && !NOT_SOURCE.test(f));
    const report: LearnReport = { learned: [], rejected: [], unsupported: [] };
    const edits: ProposedEdit[] = [];
    for (const file of files) {
        const extraction = extractEdits(file, openTree(input.beforeDir, file), openTree(input.afterDir, file));
        edits.push(...extraction.edits);
        report.unsupported.push(...extraction.unsupported.map(fn => ({ file, fn })));
    }
    if (edits.length === 0) return report;

    const candidates = edits.flatMap(edit => edit.candidates.map(pattern => toRule(edit, pattern, input.commit, maxHits)));
    const repoFiles = await sourceFiles(input.repoDir);
    const counts = countFindings(input, candidates, files, repoFiles);
    const seen = new Set<string>();
    for (const edit of edits) {
        const tried = candidates.filter(rule => rule.source.file === edit.file && rule.source.function === edit.fn && edit.candidates.includes(rule.pattern));
        const kept = tried.find(rule => failure(counts.get(rule.id)!, maxHits) === null);
        if (kept && !seen.has(kept.id)) {
            seen.add(kept.id);
            const { before, after, hits } = counts.get(kept.id)!;
            report.learned.push({ ...kept, validation: { firesBefore: before, firesAfter: after, maxHits, repoHits: hits } });
        } else if (!kept) {
            report.rejected.push({ edit, reason: failure(counts.get(tried[tried.length - 1].id)!, maxHits) ?? 'no candidate' });
        }
    }
    return report;
}

/** Learn from one file's before and after (e.g. an agent's fix), validated against the repository at `repoDir`. */
export async function learnFromFileChange(repoDir: string, file: string, before: string, after: string, maxHits?: number): Promise<LearnReport> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rigour-learn-'));
    try {
        const place = (tree: string, content: string) => {
            const target = path.join(root, tree, file);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, content);
            return path.join(root, tree);
        };
        return await learnFromFix({ beforeDir: place('before', before), afterDir: place('after', after), repoDir, files: [file], maxHits });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

function openTree(cwd: string, file: string): TreeFile {
    const root = path.join(cwd, file);
    const [program] = [...programBatches([root], loadProjectConfig(cwd).options)];
    const sourceFile = program.getSourceFile(root);
    if (!sourceFile) throw new Error(`Cannot parse ${file} in ${cwd}`);
    return { cwd, checker: program.getTypeChecker(), sourceFile };
}

interface Counts { before: number; after: number; hits: string[] }

/**
 * How often each candidate fires: before the fix, after it, and elsewhere. "After" counts only
 * the function that was fixed: an unfixed copy of the bug next to it in the same file is
 * another place the rule should find (listed with the repository hits), not a sign the rule
 * is wrong about the fix.
 */
function countFindings(input: LearnInput, rules: LearnedRule[], files: string[], repoFiles: string[]): Map<string, Counts> {
    const compiled = rules.map(compileLearnedRule);
    const tally = (dir: string, scan: string[]) => analyzeFiles(dir, scan, { rules: compiled });
    const byRule = (findings: ReturnType<typeof tally>, id: string) => findings.filter(f => f.rule === `${LEARNED_PREFIX}${id}`);
    const before = tally(input.beforeDir, files);
    const after = tally(input.afterDir, files);
    const repo = tally(input.repoDir, repoFiles);
    const keyAt = functionKeysAt(input.afterDir, files);
    return new Map(rules.map(rule => {
        const afterHits = byRule(after, rule.id);
        const atFix = afterHits.filter(f => f.file === rule.source.file && keyAt(f.file, f.line) === rule.source.function);
        const besideFix = afterHits.filter(f => !atFix.includes(f)).map(f => `${f.file}:${f.line}`);
        const elsewhere = byRule(repo, rule.id).map(f => `${f.file}:${f.line}`);
        return [rule.id, { before: byRule(before, rule.id).length, after: atFix.length, hits: [...new Set([...besideFix, ...elsewhere])] }];
    }));
}

/** The key of the function enclosing a call on a given line of a fixed file (the same key rules are scoped by). */
function functionKeysAt(dir: string, files: string[]): (file: string, line: number) => string | undefined {
    const keys = new Map<string, Map<number, string>>();
    return (file, line) => {
        if (!keys.has(file)) {
            const byLine = new Map<number, string>();
            try {
                forEachNode(openTree(dir, file).sourceFile, node => {
                    // Every line a call spans: a finding can point inside the call, not at its first line.
                    if (!isInvocation(node)) return;
                    for (let line = lineOf(node); line <= endLineOf(node); line++) if (!byLine.has(line)) byLine.set(line, functionKeyOf(node));
                });
            } catch {
                // An unparseable file attributes nothing to the fix.
            }
            keys.set(file, byLine);
        }
        return files.includes(file) ? keys.get(file)!.get(line) : undefined;
    };
}

function failure(counts: Counts, maxHits: number): string | null {
    if (counts.before === 0) return 'does not fire on the code before the fix';
    if (counts.after > 0) return `still fires ${counts.after} time(s) on the fixed code`;
    if (counts.hits.length > maxHits) return `fires on ${counts.hits.length} places in the repository (max ${maxHits})`;
    return null;
}

async function sourceFiles(cwd: string): Promise<string[]> {
    const files = await globby('**/*.{ts,tsx,js,jsx,mjs,cjs,mts,cts}', {
        cwd, gitignore: true, ignore: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/.next/**', '**/coverage/**'],
    });
    return files.filter(f => !NOT_SOURCE.test(f));
}

function toRule(edit: ProposedEdit, pattern: LearnedPattern, commit: string | undefined, maxHits: number): LearnedRule {
    return {
        id: ruleId(pattern),
        version: 1,
        pattern,
        message: messageFor(pattern, edit.file),
        severity: 'medium',
        source: { ...(commit ? { commit } : {}), file: edit.file, function: edit.fn },
        validation: { firesBefore: 0, firesAfter: 0, maxHits, repoHits: [] },
    };
}

function messageFor(pattern: LearnedPattern, file: string): string {
    const callee = pattern.callee.key.split('#').pop();
    if (pattern.template === 'require-option') {
        const value = pattern.value ? ` (e.g. '${pattern.value}')` : '';
        return `${callee}(...) does not set \`${pattern.property}\`${value} in argument ${pattern.argIndex + 1}; a fix in ${file} added it to the same call.`;
    }
    return `\`${pattern.property}\` in ${callee}(...) is not conditional on \`${pattern.guard}\`; a fix in ${file} added that condition.`;
}

function ruleId(pattern: LearnedPattern): string {
    const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24);
    const hash = crypto.createHash('sha256').update(JSON.stringify(pattern)).digest('hex').slice(0, 8);
    return `${pattern.template}-${slug(pattern.property)}-${hash}`;
}
