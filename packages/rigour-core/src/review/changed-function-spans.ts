/**
 * Line spans of the functions a change touched, per file.
 *
 * A model often reports a defect where it starts (a missing guard above the
 * edit, the declaration of a value the edit misuses) rather than on the edited
 * line. Inside a changed function, that finding is still about the change.
 */
import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { changedFunctions } from '../deep/changed-functions.js';

export type LineSpan = [number, number];

const PARSEABLE = /\.(?:[cm]?[jt]sx?)$/i;

export function changedFunctionSpans(cwd: string, changedLines: Record<string, Set<number>>): Record<string, LineSpan[]> {
    const spans: Record<string, LineSpan[]> = {};
    for (const [file, lines] of Object.entries(changedLines)) {
        if (!PARSEABLE.test(file) || lines.size === 0) continue;
        let text: string;
        try {
            text = fs.readFileSync(path.join(cwd, file), 'utf-8');
        } catch {
            continue;
        }
        const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false);
        const found = changedFunctions(sourceFile, [...lines]).map((fn): LineSpan => [
            sourceFile.getLineAndCharacterOfPosition(fn.getStart(sourceFile)).line + 1,
            sourceFile.getLineAndCharacterOfPosition(fn.getEnd()).line + 1,
        ]);
        if (found.length > 0) spans[file] = found;
    }
    return spans;
}

/** The changed line nearest to `line` inside the changed function that contains it, if any. */
export function anchorInChangedFunction(line: number, lines: Set<number> | undefined, spans: LineSpan[] | undefined): number | undefined {
    const span = spans?.find(([start, end]) => line >= start && line <= end);
    if (!span || !lines) return undefined;
    let best: number | undefined;
    for (const changed of lines) {
        if (changed < span[0] || changed > span[1]) continue;
        if (best === undefined || Math.abs(changed - line) < Math.abs(best - line)) best = changed;
    }
    return best;
}
