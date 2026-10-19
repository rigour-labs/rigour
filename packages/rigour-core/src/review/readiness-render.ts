/**
 * A readiness verdict (readiness.ts) as people read it, the same in every output: the line
 * "Technically ready: … · Product ready: …", then the coverage table compacted to one row per category with how many
 * were verified, and every failed and not verified item named. Not verified is always shown, never folded into a pass.
 */
import type { Readiness, ReadinessVerdict } from './readiness.js';
import { COVERAGE_CATEGORIES, type CoverageCategory, type CoverageRow } from './readiness-coverage.js';

/** Named items shown per cell before the rest fold into a count (the JSON has every row). */
const LISTED = 6;

interface CoverageCell {
    category: CoverageCategory;
    verified: number;
    failed: string[];
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
        return {
            category,
            verified: mine.filter(row => row.state === 'verified').reduce((n, row) => n + (row.count ?? 1), 0),
            failed: mine.filter(row => row.state === 'failed').map(label),
            notVerified: mine.filter(row => row.state === 'not verified').map(label),
        };
    });
}

function label(row: CoverageRow): string {
    const what = row.count !== undefined ? `${row.count} ${row.item}` : row.item;
    return row.detail ? `${what} (${row.detail})` : what;
}

function listed(items: string[]): string {
    const more = items.length - LISTED;
    return items.slice(0, LISTED).join(', ') + (more > 0 ? `, …and ${more} more (--json)` : '');
}

function cellText(cell: CoverageCell): string {
    if (!cell.verified && !cell.failed.length && !cell.notVerified.length) return 'none';
    return [
        ...(cell.verified ? [`${cell.verified} verified`] : []),
        ...(cell.failed.length ? [`failed: ${listed(cell.failed)}`] : []),
        ...(cell.notVerified.length ? [`not verified: ${listed(cell.notVerified)}`] : []),
    ].join(' · ');
}

/** The table as terminal lines: one per category. */
export function coverageText(r: Readiness): string[] {
    const width = Math.max(...COVERAGE_CATEGORIES.map(c => c.length));
    return coverageCells(r.coverage).map(cell => `${cell.category.padEnd(width)}  ${cellText(cell)}`);
}

/** The line and the table as markdown, for the job summary and the pull request's summary comment. */
export function readinessMarkdown(r: Readiness): string[] {
    const cell = (items: string[]) => (items.length ? listed(items) : '—').replace(/\|/g, '\\|');
    return [
        `**${readinessLine(r)}**`,
        '',
        '| Coverage | Verified | Failed | Not verified |',
        '|---|---|---|---|',
        ...coverageCells(r.coverage).map(c => `| ${c.category} | ${c.verified} | ${cell(c.failed)} | ${cell(c.notVerified)} |`),
    ];
}
