/**
 * Review a pull request as one conversation, the way a senior reviewer does:
 * read the whole diff, start with the riskiest changed functions, and look up
 * whatever a suspicion depends on before reporting it.
 *
 * Reviewing file by file, a model never sees that one file now reads a value
 * live while another still hard-codes it; on real PRs, the same model family
 * pre-empted 1 of 10 acted-on review comments file by file, and 4 of 10
 * reading the PR whole with repository tools, with fewer findings per PR.
 */
import fs from 'fs';
import path from 'path';
import type { DeepFinding, InferenceOptions, InferenceProvider } from '../inference/types.js';
import type { CodeContext } from './code-context.js';
import { REVIEW_CATEGORIES } from './code-review-prompt.js';
import { parseFindings } from './parse-findings.js';
import { diffSections } from './pr-diff.js';
import { runToolLoop } from './tool-loop.js';
import type { RelatedChange } from './related-changes.js';

const BUDGET = { maxToolCalls: 24, maxTurns: 14 };
const MAX_DIFF_CHARS = 80_000;
const MAX_FINDINGS = 5;
const PR_BODY_CHARS = 1500;

export interface FocusItem {
    file: string;
    function: string;
    start: number;
    questions: string[];
}

export interface PrReviewInput {
    cwd: string;
    diff: string;
    /** Risk-ranked changed functions to look at first, with what to check. */
    focus: FocusItem[];
    /** Changed functions called from other changed files: both sides of a contract moved. */
    related?: RelatedChange[];
    /** The team's past review lessons that apply to this change, already rendered. */
    lessons?: string;
    /** The repository's own rules that apply to this change, already rendered. */
    rules?: string;
    prBody?: string;
}

export interface PrReviewResult {
    findings: DeepFinding[];
    /** Changed files and files the model read, whole, plus what it read: what findings are grounded against. */
    contexts: CodeContext[];
    toolCalls: number;
}

export async function reviewPullRequest(provider: InferenceProvider, input: PrReviewInput, inference: InferenceOptions): Promise<PrReviewResult> {
    const { prompt, sentDiff } = buildPrPrompt(input);
    const loop = await runToolLoop(provider, prompt, input.cwd, inference, BUDGET);
    const findings = parseFindings(loop.text).slice(0, MAX_FINDINGS);
    const files = new Set([...diffSections(input.diff).map(s => s.file), ...loop.toolbox.reads.keys(), ...findings.map(f => f.file)]);
    const shown = `${sentDiff}\n${loop.toolbox.readText}`;
    return { findings, contexts: [...files].flatMap(file => wholeFile(input.cwd, file, shown)), toolCalls: loop.toolCalls };
}

export function buildPrPrompt(input: PrReviewInput): { prompt: string; sentDiff: string } {
    const related = input.related ?? [];
    const relatedFiles = new Set(related.flatMap(r => [r.calleeFile, r.callerFile]));
    const focusFiles = new Set(input.focus.map(f => f.file));
    const rank = (file: string) => (relatedFiles.has(file) ? 2 : 0) + (focusFiles.has(file) ? 1 : 0);
    const sections = diffSections(input.diff).sort((a, b) => rank(b.file) - rank(a.file));
    const sent: string[] = [];
    const omitted: string[] = [];
    let used = 0;
    for (const section of sections) {
        if (used + section.text.length <= MAX_DIFF_CHARS) {
            sent.push(section.text);
            used += section.text.length;
        } else {
            omitted.push(`- ${section.file} (+${section.addedLines} lines): use read_file`);
        }
    }
    const sentDiff = sent.join('\n\n');
    const categories = REVIEW_CATEGORIES.map(c => `- ${c.key}: ${c.focus}`).join('\n');
    const focus = input.focus.map(f => `- ${f.file}:${f.start} \`${f.function}\`: ${f.questions.join(' ')}`).join('\n');
    const contracts = related.map(r => `- \`${r.callee}\` changed at ${r.calleeFile}:${r.calleeLine}; called from ${r.callerFile}:${r.callerLine}, a file this PR also changes. Does the caller still match what the function now expects and returns?`).join('\n');
    const prompt = [
        'You are a senior engineer reviewing a pull request before it merges. Find defects this change introduces that would make the code behave wrongly, unsafely, or fail in production.',
        `CATEGORIES:\n${categories}`,
        `RULES:
1. Report only defects the change introduces, anchored on a line it added or changed: use the new-side line numbers shown in the diff, and the file path after FILE.
2. Before reporting anything that depends on code not in the diff (a caller, a callee, a type, a constant, a config value, another changed file), look it up with read_file or grep. Drop a suspicion the code disproves.
3. Do not report style, naming, formatting, tests, documentation, or speculation about code you have not read.
4. Put identifiers in backticks, spelled exactly as in the code.
5. At most ${MAX_FINDINGS} findings, only ones you are confident are real. An empty list is a good answer.
6. You have at most ${BUDGET.maxToolCalls} tool calls. Finish with ONLY JSON: {"findings":[{"category","severity","file","line","description","suggestion","confidence"}]}.`,
        input.prBody ? `PR DESCRIPTION (what the author intended):\n${input.prBody.slice(0, PR_BODY_CHARS)}` : '',
        input.rules ?? '',
        input.lessons ?? '',
        contracts ? `BOTH SIDES OF A CALL CHANGED (check these contracts first):\n${contracts}` : '',
        focus ? `LOOK FIRST (riskiest changed functions, and what to check):\n${focus}` : '',
        `PR DIFF (new-side line numbers on the left; "-" lines were removed):\n${sentDiff}`,
        omitted.length ? `NOT SHOWN (diff too large):\n${omitted.join('\n')}` : '',
    ].filter(Boolean).join('\n\n');
    return { prompt, sentDiff };
}

/** A file the review may cite anywhere in, with what the model was shown for identifier checks. */
function wholeFile(cwd: string, file: string, shown: string): CodeContext[] {
    try {
        const content = fs.readFileSync(path.join(cwd, file), 'utf-8');
        const lines = content.split('\n').length;
        return [{ file, language: '', text: '', ranges: [[1, lines]], source: `${shown}\n${content}` }];
    } catch {
        return [];
    }
}
