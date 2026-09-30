/**
 * Semantic benchmark: synthetic before/after cases per bug class.
 *
 * `before/` must produce the expected finding (recall); `after/` and cases
 * with `rule: null` must produce none (false positives).
 */
import fs from 'fs';
import path from 'path';
import { ALL_RULES, analyzeFiles } from './engine.js';

export interface BenchmarkCase {
    name: string;
    rule: string | null;
    file: string | null;
    line: number | null;
    note: string;
}

export interface CaseResult {
    case: BenchmarkCase;
    /** Expected finding reported on `before/` (true for negatives). */
    caught: boolean;
    /** Findings on `after/` plus unexpected findings on `before/`. */
    falsePositives: string[];
}

export function loadCases(root: string): BenchmarkCase[] {
    return fs.readdirSync(root, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && fs.existsSync(path.join(root, entry.name, 'case.json')))
        .map(entry => ({ name: entry.name, ...JSON.parse(fs.readFileSync(path.join(root, entry.name, 'case.json'), 'utf8')) }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

export function runCase(root: string, bench: BenchmarkCase): CaseResult {
    const before = findingsIn(path.join(root, bench.name, 'before'));
    const after = findingsIn(path.join(root, bench.name, 'after'));
    const isExpected = (f: string) => bench.rule !== null && f === `${bench.rule} ${bench.file}:${bench.line}`;
    return {
        case: bench,
        caught: bench.rule === null || before.some(isExpected),
        falsePositives: [...before.filter(f => !isExpected(f)).map(f => `before: ${f}`), ...after.map(f => `after: ${f}`)],
    };
}

function findingsIn(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    const files = fs.readdirSync(dir).filter(f => /\.[cm]?[jt]sx?$/.test(f));
    return analyzeFiles(dir, files, { rules: ALL_RULES }).map(f => `${f.rule} ${f.file}:${f.line}`);
}
