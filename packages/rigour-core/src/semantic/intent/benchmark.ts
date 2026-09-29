/**
 * Intent benchmark: labelled `Promise.all` sites for optional-read-no-fallback.
 *
 * Each case is one file (`code.ts`) whose reads are labelled optional or
 * required, and whether a finding is expected. Scoring separates the raw
 * answers from the verdicts that survive the flipped-question filter, so
 * the filter's effect (accuracy gained, answers discarded) is measured.
 */
import fs from 'fs';
import path from 'path';
import { programBatches, loadProjectConfig } from '../program.js';
import { classifyReads, findingsFor, type ReadVerdict, type YesNoModel } from './intent-check.js';
import { findParallelReads } from './parallel-reads.js';

export interface IntentCase {
    name: string;
    note: string;
    labels: Record<string, 'optional' | 'required'>;
    expectFinding: boolean;
    /** False when the finder must skip the site (no model call). */
    expectSite?: boolean;
}

export interface IntentCaseResult {
    case: IntentCase;
    siteFound: boolean;
    verdicts: ReadVerdict[];
    findings: number;
}

export interface IntentScore {
    /** Individual answers matching the label (question 1 expects yes for optional, question 2 no). */
    rawCorrect: number;
    rawTotal: number;
    /** Reads whose flipped answers agreed, and how many of those were right. */
    consistent: number;
    consistentCorrect: number;
    reads: number;
    truePositives: number;
    falseNegatives: number;
    falsePositives: number;
    finderErrors: string[];
}

export function loadIntentCases(root: string): IntentCase[] {
    return fs.readdirSync(root, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && fs.existsSync(path.join(root, entry.name, 'case.json')))
        .map(entry => ({ name: entry.name, ...readCase(path.join(root, entry.name, 'case.json')) }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

function readCase(file: string): Omit<IntentCase, 'name'> {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
        throw new Error(`Invalid intent benchmark case ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
}

export async function runIntentCase(root: string, bench: IntentCase, model: YesNoModel): Promise<IntentCaseResult> {
    const dir = path.join(root, bench.name);
    const file = path.join(dir, 'code.ts');
    const [program] = [...programBatches([file], loadProjectConfig(dir).options)];
    const [site] = findParallelReads(dir, program.getTypeChecker(), program.getSourceFile(file)!);
    if (!site) return { case: bench, siteFound: false, verdicts: [], findings: 0 };
    const verdicts = await classifyReads(model, site);
    return { case: bench, siteFound: true, verdicts, findings: findingsFor(site, verdicts).length };
}

export function scoreIntent(results: IntentCaseResult[]): IntentScore {
    const score: IntentScore = {
        rawCorrect: 0, rawTotal: 0, consistent: 0, consistentCorrect: 0, reads: 0,
        truePositives: 0, falseNegatives: 0, falsePositives: 0, finderErrors: [],
    };
    for (const result of results) {
        if (result.siteFound !== (result.case.expectSite ?? true)) score.finderErrors.push(result.case.name);
        for (const verdict of result.verdicts) scoreRead(score, verdict, result.case.labels[verdict.read.label]);
        scoreSite(score, result);
    }
    return score;
}

function scoreRead(score: IntentScore, { verdict, answers }: ReadVerdict, label: 'optional' | 'required' | undefined): void {
    if (!label) return;
    const optional = label === 'optional';
    score.reads += 1;
    score.rawTotal += 2;
    score.rawCorrect += Number(answers[0] === (optional ? 'yes' : 'no')) + Number(answers[1] === (optional ? 'no' : 'yes'));
    if (verdict === 'unknown') return;
    score.consistent += 1;
    score.consistentCorrect += Number(verdict === label);
}

function scoreSite(score: IntentScore, result: IntentCaseResult): void {
    if (result.case.expectFinding) {
        if (result.findings > 0) score.truePositives += 1; else score.falseNegatives += 1;
    } else if (result.findings > 0) {
        score.falsePositives += 1;
    }
}
