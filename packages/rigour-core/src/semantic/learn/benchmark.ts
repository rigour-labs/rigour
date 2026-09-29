/**
 * Learn benchmark: fixes whose rule `rigour learn` must reproduce.
 *
 * Each case has `before/` and `after/` trees and a `case.json` naming the rule
 * expected (or `null` when no rule may be learned). The learned rule is then
 * run over `variants/`: it must report exactly the listed locations, which
 * measures whether it generalises beyond the code it came from.
 */
import fs from 'fs';
import path from 'path';
import { analyzeFiles } from '../engine.js';
import { compileLearnedRule } from './compile.js';
import { learnFromFix, type LearnReport } from './learn.js';
import type { LearnedRule } from './types.js';

export interface LearnCase {
    name: string;
    note: string;
    expect: { template: string; property: string; guard?: string; scoped: boolean } | null;
    variants?: string[];
    unsupported?: string[];
}

export interface LearnCaseResult {
    case: LearnCase;
    report: LearnReport;
    problems: string[];
}

export function loadLearnCases(root: string): LearnCase[] {
    return fs.readdirSync(root, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && fs.existsSync(path.join(root, entry.name, 'case.json')))
        .map(entry => ({ name: entry.name, ...readCase(path.join(root, entry.name, 'case.json')) }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

function readCase(file: string): Omit<LearnCase, 'name'> {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
        throw new Error(`Invalid learn benchmark case ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
}

export async function runLearnCase(root: string, bench: LearnCase): Promise<LearnCaseResult> {
    const dir = path.join(root, bench.name);
    const beforeDir = path.join(dir, 'before');
    const afterDir = path.join(dir, 'after');
    const report = await learnFromFix({ beforeDir, afterDir, repoDir: afterDir, files: changedFiles(beforeDir, afterDir) });
    const problems = [...expectationProblems(bench, report)];
    const [rule] = report.learned;
    if (rule && bench.variants) problems.push(...variantProblems(path.join(dir, 'variants'), rule, bench.variants));
    return { case: bench, report, problems };
}

function changedFiles(beforeDir: string, afterDir: string): string[] {
    return fs.readdirSync(beforeDir).filter(name => {
        const after = path.join(afterDir, name);
        return fs.existsSync(after) && fs.readFileSync(path.join(beforeDir, name), 'utf8') !== fs.readFileSync(after, 'utf8');
    });
}

function expectationProblems(bench: LearnCase, report: LearnReport): string[] {
    const problems: string[] = [];
    for (const fn of bench.unsupported ?? []) {
        if (!report.unsupported.some(u => u.fn === fn)) problems.push(`expected ${fn} to be reported unsupported`);
    }
    if (bench.expect === null) {
        if (report.learned.length > 0) problems.push(`learned ${report.learned.map(r => r.id).join(', ')} but no rule was expected`);
        return problems;
    }
    const want = bench.expect;
    const matches = report.learned.filter(rule => rule.pattern.template === want.template
        && rule.pattern.property === want.property
        && (rule.pattern.template !== 'require-guard' || rule.pattern.guard === want.guard)
        && Boolean(rule.pattern.scope) === want.scoped);
    if (matches.length !== 1 || report.learned.length !== 1) {
        problems.push(`expected one ${want.template} rule for ${want.property}; learned ${JSON.stringify(report.learned.map(r => r.pattern))}, rejected ${report.rejected.map(r => r.reason).join('; ')}`);
    }
    return problems;
}

function variantProblems(variantsDir: string, rule: LearnedRule, expected: string[]): string[] {
    const files = fs.readdirSync(variantsDir).filter(f => /\.[cm]?[jt]sx?$/.test(f));
    const found = analyzeFiles(variantsDir, files, { rules: [compileLearnedRule(rule)] }).map(f => `${f.file}:${f.line}`).sort();
    const want = [...expected].sort();
    return JSON.stringify(found) === JSON.stringify(want) ? [] : [`variants: expected ${want.join(', ') || 'none'}, got ${found.join(', ') || 'none'}`];
}
