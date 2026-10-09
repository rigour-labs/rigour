/**
 * The orchestrator's router: which specialists a change needs, hunk by hunk, decided without a model, and how many
 * passes that takes. One combined pass is the default at every size; a change is split only when one pass would not
 * fit the judge (MAX_PASS_DIFF_CHARS), and never into more than MAX_PASSES. A change with nothing for a model to review
 * (a lockfile, generated files) gets no pass at all: the deterministic checks are for that.
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

/** The most diff one pass is given: past this a judge's context runs out before it has read its part, so the change is split. */
const MAX_PASS_DIFF_CHARS = 120_000;
/** The most passes one review runs, split or not. */
const MAX_PASSES = 3;

const TEST = /(^|\/)(__tests__|tests?|spec)\/|\.(test|spec)\.[A-Za-z0-9]+$/;
const DOC = /\.(md|mdx|txt|rst|adoc)$|(^|\/)docs?\//i;
const LOCK = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|poetry\.lock|go\.sum|Gemfile\.lock|composer\.lock|bun\.lockb)$/;
const GENERATED = /(\.|-|_)(gen|generated|pb)\.[cm]?[jt]sx?$|\.d\.ts\.map$|(^|\/)(__generated__|generated|gen)\/|\.min\.[cm]?js$|\.snap$/i;
const CODE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|go|rs|java|rb|kt|kts|swift|svelte|vue|sql|php|cs|scala|dart)$/;
const MIGRATION = /(^|\/)(migrations?|db\/migrate|schema)\/|\.sql$|(^|\/)schema\.prisma$/i;

/** Lines that read data: queries in TS/JS, Python, Go and SQL, pagination, and a loop that awaits on every turn. */
const READS = [
    /\b(select|insert|update|delete)\b[\s\S]{0,80}\b(from|into|set|where)\b/i,
    /\.(query|queryRaw|find|findMany|findFirst|findOne|findAll|findUnique|aggregate|count|select|from|where|rpc)\s*\(/,
    /\bfetch\s*\(/,
    /\b(offset|limit|range|cursor|page_size|pageSize|per_page)\b/,
    /\.(execute|executemany|fetchall|fetchone|filter|all|get)\s*\(|\bsession\.query\b|\bobjects\.(filter|all|get|exclude)\b|\bcursor\./,
    /\.(Query|QueryRow|QueryContext|QueryRowContext|Exec|ExecContext|Select|Find|Get)\s*\(|\brows\.Next\s*\(/,
    /\bcreate\s+(unique\s+)?index\b|\balter\s+table\b|\bcreate\s+table\b/i,
];
const LOOP = /\b(for|while)\b|\.(forEach|map|flatMap|reduce)\s*\(\s*async\b|\basync\s+for\b/;
const AWAIT = /\bawait\b/;
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
        const skipped = LOCK.test(hunk.file) || GENERATED.test(hunk.file);
        if (skipped) return;
        const lines = [...hunk.added, ...hunk.removed];
        const code = CODE.test(hunk.file) && !TEST.test(hunk.file) && !DOC.test(hunk.file);
        if (code) pick('correctness', i);
        const reads = READS.some(pattern => lines.some(line => pattern.test(line))) || (lines.some(l => LOOP.test(l)) && lines.some(l => AWAIT.test(l)));
        if ((code || MIGRATION.test(hunk.file)) && (reads || MIGRATION.test(hunk.file))) pick('production-cost', i);
        if (code && (hunk.removed.length > 0 || hunk.newFile || hunk.added.some(l => DECLARES.test(l)))) pick('cleanup', i);
        if (DOC.test(hunk.file) || hunk.added.some(l => COMMENT.test(l)) || ((code || DOC.test(hunk.file)) && (context.rulesAndLessons > 0 || context.goal))) pick('rules-and-goal', i);
    });
    if (context.humanReviews > 0) picked.set('prior-points', hunks.map((_, i) => i).filter(i => !LOCK.test(hunks[i].file) && !GENERATED.test(hunks[i].file)));
    return picked;
}

/** A pass's part of the diff: its hunks, and every other hunk that defines a name they use. */
export function slice(hunks: Hunk[], indices: number[]): string {
    const chosen = new Set(indices);
    const referenced = new Set(indices.flatMap(i => [...hunks[i].references]));
    hunks.forEach((hunk, i) => {
        if (!chosen.has(i) && [...hunk.defines].some(name => referenced.has(name))) chosen.add(i);
    });
    return [...chosen].sort((a, b) => a - b).map(i => hunks[i].text).join('');
}

export interface Pass { specialists: string[]; hunks: number[]; diff: string }

/**
 * The passes for what triage picked: one combined pass with every picked specialist, unless its part of the diff
 * passes MAX_PASS_DIFF_CHARS; then the specialists are grouped, largest part first, into at most MAX_PASSES passes.
 * `combinedOnly` (the cost guard) keeps it one pass whatever the size.
 */
export function planPasses(hunks: Hunk[], picked: Map<string, number[]>, order: readonly Specialist[], combinedOnly = false): Pass[] {
    const ids = order.map(s => s.id).filter(id => picked.has(id));
    if (ids.length === 0) return [];
    const union = [...new Set(ids.flatMap(id => picked.get(id)!))].sort((a, b) => a - b);
    const whole: Pass = { specialists: ids, hunks: union, diff: slice(hunks, union) };
    if (combinedOnly || whole.diff.length <= MAX_PASS_DIFF_CHARS || ids.length === 1) return [whole];
    const groups: Array<{ specialists: string[]; hunks: Set<number> }> = [];
    for (const id of [...ids].sort((a, b) => picked.get(b)!.length - picked.get(a)!.length)) {
        const target = groups.length < MAX_PASSES ? undefined : groups.reduce((small, g) => (g.hunks.size < small.hunks.size ? g : small));
        if (target) {
            target.specialists.push(id);
            picked.get(id)!.forEach(i => target.hunks.add(i));
        } else groups.push({ specialists: [id], hunks: new Set(picked.get(id)!) });
    }
    return groups.map(g => {
        const indices = [...g.hunks].sort((a, b) => a - b);
        return { specialists: order.map(s => s.id).filter(id => g.specialists.includes(id)), hunks: indices, diff: slice(hunks, indices) };
    });
}
