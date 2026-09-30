/**
 * The exact prompt the max tier would review for each changed file of a diff.
 *
 * The driftbench review miner pairs these prompts with what the later fix
 * changed, so a fine-tuned model learns from the input it will get at runtime,
 * built by the same code (numbered source, focus segments, reference pack).
 */
import fs from 'fs';
import path from 'path';
import { changedLinesByFile, parseDiff, removedByFile } from '../utils/diff.js';
import { buildCodeContext } from './code-context.js';
import { buildCodeReviewPrompt } from './code-review-prompt.js';
import { extractFacts } from './fact-extractor.js';
import { buildReferencePack } from './reference-pack.js';

export interface ReviewContextExport {
    file: string;
    focusLines: number[];
    prompt: string;
}

export interface ReviewContextOptions {
    prBody?: string;
    maxSourceChars?: number;
    maxReferenceChars?: number;
}

export async function exportReviewContexts(cwd: string, diff: string, options: ReviewContextOptions = {}): Promise<ReviewContextExport[]> {
    const focus = changedLinesByFile(parseDiff(diff));
    const removed = removedByFile(diff);
    const files = Object.keys(focus).filter(f => focus[f].length > 0 && fs.existsSync(path.join(cwd, f)));
    if (files.length === 0) return [];
    const facts = await extractFacts(cwd, [], files);
    return facts.map(fileFacts => {
        const content = fs.readFileSync(path.join(cwd, fileFacts.path), 'utf-8');
        const context = buildCodeContext(fileFacts, content, { maxChars: options.maxSourceChars ?? 36_000, focusLines: focus[fileFacts.path] });
        const pack = buildReferencePack({
            cwd, file: fileFacts.path, focusLines: focus[fileFacts.path], removed: removed[fileFacts.path],
            prBody: options.prBody, maxChars: options.maxReferenceChars ?? 12_000,
        });
        return { file: fileFacts.path, focusLines: focus[fileFacts.path], prompt: buildCodeReviewPrompt(context, pack.text) };
    });
}
