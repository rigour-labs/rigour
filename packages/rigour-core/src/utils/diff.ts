/**
 * Unified diff → added line numbers per file (new-side numbering).
 * Shared by `rigour review` and the MCP review tool.
 *
 * Hunk bodies are consumed by the line counts in their `@@` header, so a
 * content line that happens to start with `+++` or `---` is never mistaken
 * for a file header.
 */
interface ParseState {
    mapping: Record<string, Set<number>>;
    file: string;
    newLine: number;
    oldLeft: number;
    newLeft: number;
}

export function parseDiff(diff: string): Record<string, Set<number>> {
    const state: ParseState = { mapping: {}, file: '', newLine: 0, oldLeft: 0, newLeft: 0 };
    for (const line of diff.split('\n')) {
        if (state.oldLeft > 0 || state.newLeft > 0) readHunkLine(state, line);
        else readHeaderLine(state, line);
    }
    return state.mapping;
}

function readHunkLine(state: ParseState, line: string): void {
    if (line.startsWith('\\')) return; // "\ No newline at end of file"
    if (line.startsWith('-')) {
        state.oldLeft--;
        return;
    }
    if (line.startsWith('+')) {
        if (state.file) state.mapping[state.file].add(state.newLine);
    } else {
        state.oldLeft--;
    }
    state.newLine++;
    state.newLeft--;
}

function readHeaderLine(state: ParseState, line: string): void {
    if (line.startsWith('diff --git ')) {
        state.file = '';
    } else if (line.startsWith('+++ ')) {
        state.file = line.startsWith('+++ b/') ? line.slice(6).trim() : '';
        if (state.file) state.mapping[state.file] ??= new Set();
    } else if (line.startsWith('@@')) {
        readHunkHeader(state, line);
    }
}

function readHunkHeader(state: ParseState, line: string): void {
    const hunk = line.match(/^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!hunk) return;
    state.oldLeft = hunk[1] === undefined ? 1 : parseInt(hunk[1], 10);
    state.newLine = parseInt(hunk[2], 10);
    state.newLeft = hunk[3] === undefined ? 1 : parseInt(hunk[3], 10);
}

/** Changed lines as sorted arrays, the shape DeepOptions.focusLines takes. */
export function changedLinesByFile(mapping: Record<string, Set<number>>): Record<string, number[]> {
    return Object.fromEntries(
        Object.entries(mapping).map(([file, lines]) => [file, [...lines].sort((a, b) => a - b)]),
    );
}
