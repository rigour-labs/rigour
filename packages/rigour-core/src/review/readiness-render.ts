/**
 * A readiness verdict (readiness.ts) as people read it, the same in every output: the line
 * "Technically ready: … · Product ready: …", then the coverage table compacted to one row per category with how many
 * were verified, and every failed, noted and not verified item named (the first few, then a count; the JSON has every
 * row). Not verified is always shown, never folded into a pass.
 */
import type { Readiness, ReadinessVerdict } from './readiness.js';
import { COVERAGE_CATEGORIES, type CoverageCategory, type CoverageRow } from './readiness-coverage.js';

/** Named items shown per cell before the rest fold into a count. */
const LISTED = 6;
/** The terminal width a coverage line wraps at, when the terminal does not say. */
const WIDTH = 100;

interface CoverageCell {
    category: CoverageCategory;
    verified: number;
    failed: string[];
    noted: string[];
    notVerified: string[];
}

/** The JSON shape every machine-read output gives (`rigour review --json`, the MCP tool): the line as printed, then every verdict and row. */
export function readinessJson(r: Readiness): Readiness & { line: string } {
    return { line: readinessLine(r), technical: r.technical, product: r.product, coverage: r.coverage };
}

export function readinessLine(r: Readiness): string {
    return `Technically ready: ${verdictText(r.technical)} · Product ready: ${verdictText(r.product)}`;
}

function verdictText(v: ReadinessVerdict): string {
    const why = [...v.reasons, ...v.caveats];
    return why.length ? `${v.state} (${why.join('; ')})` : v.state;
}

/** One cell per category, in a fixed order, so a category with nothing in it still shows. */
function coverageCells(rows: CoverageRow[]): CoverageCell[] {
    return COVERAGE_CATEGORIES.map(category => {
        const mine = rows.filter(row => row.category === category);
        const named = (state: CoverageRow['state']) => mine.filter(row => row.state === state).map(label);
        return {
            category,
            verified: mine.filter(row => row.state === 'verified').reduce((n, row) => n + (row.count ?? 1), 0),
            failed: named('failed'),
            noted: named('noted'),
            notVerified: named('not verified'),
        };
    });
}

function label(row: CoverageRow): string {
    const what = row.count !== undefined ? `${row.count} ${row.item}` : row.item;
    return row.detail ? `${what} (${row.detail})` : what;
}

function listed(items: string[], more: string): string {
    const left = items.length - LISTED;
    return items.slice(0, LISTED).join(', ') + (left > 0 ? `, …and ${left} more ${more}` : '');
}

function cellParts(cell: CoverageCell): string[] {
    if (!cell.verified && !cell.failed.length && !cell.noted.length && !cell.notVerified.length) return ['none'];
    return [
        ...(cell.verified ? [`${cell.verified} verified`] : []),
        ...(cell.failed.length ? [`failed: ${listed(cell.failed, '(--json)')}`] : []),
        ...(cell.noted.length ? [`noted: ${listed(cell.noted, '(--json)')}`] : []),
        ...(cell.notVerified.length ? [`not verified: ${listed(cell.notVerified, '(--json)')}`] : []),
    ];
}

/** `text` after `prefix`, its words wrapped to `width`, every line after the first starting with `indent`. */
function wrap(prefix: string, text: string, width: number, indent: string): string[] {
    const lines: string[] = [];
    let line = prefix;
    let fresh = true;
    for (const word of text.split(' ')) {
        if (!fresh && line.length + 1 + word.length > width) {
            lines.push(line);
            line = indent + word;
        } else line = fresh ? line + word : `${line} ${word}`;
        fresh = false;
    }
    return [...lines, line];
}

/** The table as terminal lines: a row per category, each part on its own line when they do not fit, wrapped at `width`. */
export function coverageText(r: Readiness, width = WIDTH): string[] {
    const pad = Math.max(...COVERAGE_CATEGORIES.map(c => c.length)) + 2;
    const indent = ' '.repeat(pad);
    return coverageCells(r.coverage).flatMap(cell => {
        const parts = cellParts(cell);
        const one = `${cell.category.padEnd(pad)}${parts.join(' · ')}`;
        if (one.length <= width) return [one];
        return parts.flatMap((part, i) => wrap(i ? indent : cell.category.padEnd(pad), part, width, indent));
    });
}

/** The line and the table as markdown, for the job summary and the pull request's summary comment. */
export function readinessMarkdown(r: Readiness): string[] {
    const cell = (items: string[]) => (items.length ? listed(items, 'in the JSON report (the job\'s report artifact)') : '—').replace(/\|/g, '\\|');
    return [
        `**${readinessLine(r)}**`,
        '',
        '| Coverage | Verified | Failed | Noted | Not verified |',
        '|---|---|---|---|---|',
        ...coverageCells(r.coverage).map(c => `| ${c.category} | ${c.verified} | ${cell(c.failed)} | ${cell(c.noted)} | ${cell(c.notVerified)} |`),
    ];
}
