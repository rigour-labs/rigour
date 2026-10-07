/**
 * The points a person makes in a review body: its bullet and numbered lines, each cut to its first
 * line. One reader for the backtest's ledger and the learner, so both see the same points.
 */
const BULLET = /^\s*(?:[-*]|\d+[.)])\s+(.{8,})$/;

/** The bullet and numbered lines of a review body: the points a reviewer makes outside any one line. */
export function bodyPoints(body: string): string[] {
    return body.split('\n').map(l => BULLET.exec(l)?.[1]).filter((l): l is string => !!l).map(firstLine);
}

/** A comment's first non-empty line, markup removed, at most 140 characters. */
export function firstLine(text: string): string {
    const line = text.split('\n').find(l => l.trim())?.replace(/[*_`#]/g, '').trim() ?? '';
    return line.length > 140 ? `${line.slice(0, 137)}...` : line;
}
