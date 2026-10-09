/**
 * Which characters of a source file are code, and which sit inside a string literal or a line comment: what tells a
 * call (`subprocess.call(cmd, shell=True)`) from the same text in a message (`MSG = "subprocess.call(...)"`).
 *
 * The string literals are the ones `stripStrings` already strips (side-effect-helpers/types.ts): `"…"`, `'…'` and
 * `` `…` ``, with backslash escapes. A line comment starts at `#` (Python, Ruby, shell) or `//` (the C family) outside
 * a string. Every line starts as code: nothing carries to the next line, so a regex literal holding a quote (`/"/`) or
 * an unclosed quote affects only its own line and can never hide a real call below it.
 *
 * Two limits, both narrowing a false positive and never losing a match the gates made before:
 * - a string or a block comment spanning lines (a Python `"""` docstring, a multi-line template literal, `/* … *\/`)
 *   is read as code past its first line, as before;
 * - code inside a string interpolation (Python `f"{…}"`, JS `${…}`, Ruby `#{…}`) is string, so a call written inside
 *   one does not count as a call.
 */

const LITERAL: Record<string, RegExp> = {
    '"': /"(?:[^"\\]|\\.)*"/y,
    "'": /'(?:[^'\\]|\\.)*'/y,
    '`': /`(?:[^`\\]|\\.)*`/y,
};

const HASH_COMMENTS = new Set(['py', 'rb', 'sh', 'bash', 'zsh', 'yml', 'yaml', 'toml', 'r', 'pl']);

/** For one line, whether column `col` is code. `ext` is the file's extension, which decides the comment marker. */
export function codeColumns(line: string, ext: string): (col: number) => boolean {
    const hash = HASH_COMMENTS.has(ext.toLowerCase());
    const masked = new Uint8Array(line.length);
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if ((hash && c === '#') || (!hash && c === '/' && line[i + 1] === '/')) {
            masked.fill(1, i);
            break;
        }
        const literal = LITERAL[c];
        if (!literal) continue;
        literal.lastIndex = i;
        const m = literal.exec(line);
        if (!m) continue; // an unclosed quote: the rest of the line stays code
        masked.fill(1, i, i + m[0].length);
        i += m[0].length - 1;
    }
    return col => col < 0 || col >= line.length || masked[col] === 0;
}

/** For a whole file, whether the character at `offset` is code: line by line, each line starting as code. */
export function codeOffsets(content: string, ext: string): (offset: number) => boolean {
    const starts: number[] = [0];
    for (let i = 0; i < content.length; i++) if (content[i] === '\n') starts.push(i + 1);
    const lines = new Map<number, (col: number) => boolean>();
    return offset => {
        let lo = 0;
        let hi = starts.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (starts[mid] <= offset) lo = mid;
            else hi = mid - 1;
        }
        if (!lines.has(lo)) {
            const end = lo + 1 < starts.length ? starts[lo + 1] - 1 : content.length;
            lines.set(lo, codeColumns(content.slice(starts[lo], end), ext));
        }
        return lines.get(lo)!(offset - starts[lo]);
    };
}
