/**
 * The orchestrator's router: which specialists a change needs, hunk by hunk, decided without a model, and the passes
 * that takes. One combined pass is the plan at every size; a change over the judge's limit (orchestrator.ts passLimit)
 * also gets a split by hunk, each part within the limit, which runs only when the savings ledger covers it. A change
 * with nothing for a model to review (only lockfiles, generated files) gets no pass at all.
 */
import type { Specialist } from './orchestrator.js';

export interface Hunk {
    file: string;
    /** The hunk as it appears in the diff, its file header included, so a slice is itself a diff. */
    text: string;
    added: string[];
    removed: string[];
    newFile: boolean;
    /** Names the hunk defines on an added line (function, const, class, type). */
    defines: Set<string>;
    /** Every identifier on its added and removed lines. */
    references: Set<string>;
}

/** Prose: its own words are for the rules and the goal, never a correctness pass. Matched by extension only: a `docs/` folder holds code too. */
const PROSE = /\.(md|mdx|txt|rst|adoc)$/i;
/**
 * The only files no model reviews: lockfiles, snapshots, source maps, minified bundles and files a generator marks
 * as its own (`__generated__/`, `.generated.`, protobuf output). Everything else gets a correctness pass, whatever
 * its language: a missed skip costs a little, a wrong one leaves code unreviewed.
 */
const SKIP = [
    /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|poetry\.lock|Pipfile\.lock|uv\.lock|go\.sum|Gemfile\.lock|composer\.lock|bun\.lockb?)$/,
    /\.snap$/, /\.(js|css|d\.ts)\.map$/, /\.min\.(js|css)$/,
    /(^|\/)__generated__\//, /\.generated\.[A-Za-z0-9]+$/, /\.pb\.go$/, /_pb2(_grpc)?\.pyi?$/, /_pb\.(js|ts|d\.ts)$/,
];
/** The most parts a split runs: a change that needs more is one combined pass. */
export const MAX_PARTS = 3;
const MIGRATION = /(^|\/)(migrations?|db\/migrate)\/|\.sql$|(^|\/)schema\.prisma$/i;

/**
 * Lines that read data, per language. Each names a query API, not a word any code uses: `Array.from`, `map.get`,
 * `items.filter` and a `limit` variable are not reads.
 */
const READS = [
    // SQL, in a .sql file or a string
    /\bselect\s[\s\S]{0,80}?\bfrom\s+[A-Za-z_"`[]|\binsert\s+into\b|\bupdate\s+[A-Za-z_"`.]+\s+set\b|\bdelete\s+from\b|\bcreate\s+(unique\s+)?index\b|\balter\s+table\b|\bcreate\s+table\b|\blimit\s+\d+|\boffset\s+\d+/i,
    // TS/JS: ORMs, query builders, Supabase, fetch
    /\.(query|queryRaw|\$queryRaw|\$executeRaw|findMany|findFirst|findUnique|findOne|findAll|aggregate|groupBy|rpc)\s*\(|\.from\(\s*['"`]|\bfetch\s*\(|\.(range|limit|offset)\s*\(\s*\d/,
    // Python: DB-API, SQLAlchemy, Django
    /\.(execute|executemany|fetchall|fetchone|fetchmany)\s*\(|\bsession\.(query|execute|scalars)\s*\(|\.objects\.(filter|all|get|exclude|raw)\s*\(/,
    // Go: database/sql, sqlx, GORM on a db/tx/conn value
    /\.(Query|QueryRow|QueryContext|QueryRowContext|Exec|ExecContext)\s*\(|\b(db|tx|conn)\.(Get|Select|Find|First|Where)\s*\(|\brows\.Next\s*\(/,
];
/** A loop, and an await within the next few lines of it: one read per turn. */
const LOOP = /\b(for|while)\b\s*[(\w]|\.(forEach|map|flatMap|reduce)\s*\(\s*async\b|\basync\s+for\b/;
const AWAIT = /\bawait\b/;
const LOOP_REACH = 3;
const DEFINES = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|interface|type|enum|def|func)\s+(?:\([^)]*\)\s*)?([A-Za-z_$][\w$]*)/;
const DECLARES = /^\s*(export\s|(async\s+)?function\s|def\s|func\s|class\s)/;
const COMMENT = /^\s*(\/\/|#|\/\*|\*|<!--)/;
const IDENTIFIER = /[A-Za-z_$][\w$]{2,}/g;

/** The diff's hunks, each with its file header. */
export function parseHunks(diff: string): Hunk[] {
    const hunks: Hunk[] = [];
    for (const block of diff.split(/^(?=diff --git )/m)) {
        const file = /^diff --git a\/.+? b\/(.+)$/m.exec(block)?.[1];
        if (!file) continue;
        const headerEnd = block.search(/^@@/m);
        const header = headerEnd >= 0 ? block.slice(0, headerEnd) : block;
        const newFile = /^new file mode|^--- \/dev\/null$/m.test(header);
        const bodies = headerEnd >= 0 ? block.slice(headerEnd).split(/^(?=@@)/m) : [];
        for (const body of bodies) {
            const lines = body.split('\n');
            const added = lines.filter(l => l.startsWith('+') && !l.startsWith('+++')).map(l => l.slice(1));
            const removed = lines.filter(l => l.startsWith('-') && !l.startsWith('---')).map(l => l.slice(1));
            const defines = new Set(added.map(l => DEFINES.exec(l)?.[1]).filter((n): n is string => !!n));
            const references = new Set([...added, ...removed].flatMap(l => l.match(IDENTIFIER) ?? []));
            hunks.push({ file, text: `${header}${body}`, added, removed, newFile, defines, references });
        }
    }
    return hunks;
}

export interface TriageContext {
    /** Human reviews on the pull request: the prior-points specialist is for them. */
    humanReviews: number;
    /** Rules and lessons the team's knowledge serves for this change. */
    rulesAndLessons: number;
    /** The goal step has items for a model to judge. */
    goal: boolean;
}

/** Per specialist, the hunks it is for (by index); a specialist absent from the map is not needed. Prior points take the whole change. */
export function triage(hunks: Hunk[], context: TriageContext): Map<string, number[]> {
    const picked = new Map<string, number[]>();
    const pick = (id: string, index: number) => picked.set(id, [...(picked.get(id) ?? []), index]);
    hunks.forEach((hunk, i) => {
        if (skipped(hunk.file)) return;
        const prose = PROSE.test(hunk.file);
        const lines = [...hunk.added, ...hunk.removed];
        if (!prose) pick('correctness', i);
        if (!prose && (MIGRATION.test(hunk.file) || READS.some(pattern => lines.some(line => pattern.test(line))) || awaitsInLoop(hunk.added))) pick('production-cost', i);
        if (!prose && (hunk.removed.length > 0 || hunk.newFile || hunk.added.some(l => DECLARES.test(l)))) pick('cleanup', i);
        if (prose || hunk.added.some(l => COMMENT.test(l)) || context.rulesAndLessons > 0 || context.goal) pick('rules-and-goal', i);
    });
    if (context.humanReviews > 0) picked.set('prior-points', hunks.map((_, i) => i).filter(i => !skipped(hunks[i].file)));
    return picked;
}

/** Lines that write data, per language: an ORM or query builder's write, or SQL that changes rows. Not `map.set`. */
const WRITES = /\.(insert|insertMany|upsert|update|updateMany|delete|deleteMany|save|create|createMany|bulkCreate|bulk_create)\s*\(|\b(insert\s+into|update\s+[A-Za-z_"`.]+\s+set|delete\s+from)\b/i;

/**
 * Whether the change touches data: a read or a write in a query API, a migration, or an await inside a loop. The data
 * passes of the reviewer's instructions (read trace, journey) are asked for only then.
 */
export function touchesData(hunks: Hunk[]): boolean {
    return hunks.some(hunk => {
        if (skipped(hunk.file) || PROSE.test(hunk.file)) return false;
        const lines = [...hunk.added, ...hunk.removed];
        return MIGRATION.test(hunk.file) || lines.some(line => WRITES.test(line) || READS.some(pattern => pattern.test(line))) || awaitsInLoop(hunk.added);
    });
}

/** Whether a file is a migration or a schema (a change a cheaper model may miss the cost of). */
export function isMigration(file: string): boolean {
    return MIGRATION.test(file);
}

/** Whether no model reviews this file (SKIP). */
export function skipped(file: string): boolean {
    return SKIP.some(pattern => pattern.test(file));
}

function awaitsInLoop(lines: string[]): boolean {
    return lines.some((line, i) => LOOP.test(line) && lines.slice(i, i + LOOP_REACH + 1).some(l => AWAIT.test(l)));
}

/**
 * A pass's part of the diff: its hunks, and the hunk defining each name they use, in diff order. Only a name exactly one
 * hunk defines is followed (a local `result` defined in ten files is no one definition), and a definition is added only
 * while the part stays within `limit`.
 */
function sliceOf(hunks: Hunk[], definedIn: Map<string, number[]>, indices: number[], limit: number): number[] {
    const chosen = new Set(indices);
    let size = indices.reduce((sum, i) => sum + hunks[i].text.length, 0);
    const referenced = new Set(indices.flatMap(i => [...hunks[i].references]));
    for (const name of referenced) {
        const at = definedIn.get(name);
        if (at?.length !== 1 || chosen.has(at[0]) || size + hunks[at[0]].text.length > limit) continue;
        chosen.add(at[0]);
        size += hunks[at[0]].text.length;
    }
    return [...chosen].sort((a, b) => a - b);
}

export interface Pass {
    specialists: string[];
    /** The hunks triage picked for it. */
    hunks: number[];
    /** What it is given: its hunks and the hunks defining what they use. */
    sliced: number[];
    diff: string;
}

export interface Plan {
    /** One pass with every picked specialist; undefined when triage picked nothing. */
    combined?: Pass;
    /** Present only when the combined pass is over `limit`: the picked hunks in parts, each within it where one hunk allows. */
    split?: Pass[];
    /** The parts a change over `limit` would need, when that is more than MAX_PARTS: no split, one combined pass. */
    needsParts?: number;
}

/**
 * The passes for what triage picked. A split is by hunk, in diff order: each part takes the next hunks while they stay
 * within `limit`, and runs every specialist that picked any of them. A single hunk over the limit is a part of its own.
 * A change that needs more than MAX_PARTS parts is not split.
 */
export function planPasses(hunks: Hunk[], picked: Map<string, number[]>, order: readonly Specialist[], limit: number): Plan {
    const ids = order.map(s => s.id).filter(id => picked.has(id));
    if (ids.length === 0) return {};
    const definedIn = new Map<string, number[]>();
    hunks.forEach((hunk, i) => hunk.defines.forEach(name => definedIn.set(name, [...(definedIn.get(name) ?? []), i])));
    const pickedBy = new Map(ids.map(id => [id, new Set(picked.get(id)!)]));
    const pass = (indices: number[]): Pass => {
        const sliced = sliceOf(hunks, definedIn, indices, limit);
        return { specialists: ids.filter(id => indices.some(i => pickedBy.get(id)!.has(i))), hunks: indices, sliced, diff: sliced.map(i => hunks[i].text).join('') };
    };
    const union = [...new Set(ids.flatMap(id => picked.get(id)!))].sort((a, b) => a - b);
    const combined = pass(union);
    if (combined.diff.length <= limit || union.length === 1) return { combined };
    // By the hunks' own size: definitions join a part only within the limit (sliceOf), so they never push it over.
    const parts: number[][] = [[]];
    let size = 0;
    for (const index of union) {
        const length = hunks[index].text.length;
        if (parts.at(-1)!.length && size + length > limit) {
            parts.push([]);
            size = 0;
        }
        parts.at(-1)!.push(index);
        size += length;
    }
    if (parts.length > MAX_PARTS) return { combined, needsParts: parts.length };
    return parts.length > 1 ? { combined, split: parts.map(pass) } : { combined };
}

/** Characters of the reviewable diff (no lockfiles or generated files) and its changed lines: both modes are measured on this. */
export function reviewable(hunks: Hunk[]): { chars: number; lines: number } {
    const kept = hunks.filter(h => !skipped(h.file));
    return { chars: kept.reduce((sum, h) => sum + h.text.length, 0), lines: kept.reduce((sum, h) => sum + h.added.length + h.removed.length, 0) };
}
