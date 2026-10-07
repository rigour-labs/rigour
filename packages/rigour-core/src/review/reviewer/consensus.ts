/**
 * How a panel agrees, as pure functions: when two judges' items are the same finding (similarity),
 * the minimum-cost one-to-one assignment (the Hungarian algorithm), the grouping of every judge's
 * items into findings, and the majority rule that decides a finding from every judge's call.
 * Deterministic: inputs sorted, ties broken on file, line and id. panel.ts runs the judges around it.
 */
import type { OpenItem } from './verdict.js';

export type Call = 'raised' | 'confirm' | 'refute' | 'unsure' | 'not asked';
export type PanelStatus = 'confirmed' | 'disputed' | 'dropped';

/** Similarity at or above which two items are the same finding. */
export const MATCH_THRESHOLD = 0.5;
/** Below this share of words, two items are the same finding only on the same line and in the same class. */
const MIN_SHARED_WORDS = 0.15;
const LINE_WINDOW = 5;
const STOP = new Set(['the', 'and', 'for', 'that', 'this', 'with', 'from', 'when', 'into', 'are', 'not', 'but', 'its', 'has', 'have', 'every', 'each', 'one', 'can']);

export const order = (a: OpenItem, b: OpenItem) => (a.file ?? '').localeCompare(b.file ?? '') || (a.line ?? 0) - (b.line ?? 0) || a.id.localeCompare(b.id);

/** Shared words over all words (Jaccard) of two items' issue and consequence. */
export function textSimilarity(a: OpenItem, b: OpenItem): number {
    const wa = words(a);
    const wb = words(b);
    const shared = [...wa].filter(w => wb.has(w)).length;
    return wa.size + wb.size - shared ? shared / (wa.size + wb.size - shared) : 0;
}

function words(item: OpenItem): Set<string> {
    const text = `${item.issue} ${item.consequence ?? ''}`.toLowerCase();
    return new Set((text.match(/[a-z_][a-z0-9_]{2,}/g) ?? []).filter(w => !STOP.has(w)));
}

/** 0 for different files; otherwise wording, line distance and class, weighted. A far-apart pair needs close wording. */
export function similarity(a: OpenItem, b: OpenItem): number {
    if (!a.file || a.file !== b.file) return 0;
    const text = textSimilarity(a, b);
    const distance = a.line !== undefined && b.line !== undefined ? Math.abs(a.line - b.line) : undefined;
    const line = distance === undefined ? 0.5 : distance <= LINE_WINDOW ? 1 - distance / (LINE_WINDOW + 1) : 0;
    if (line === 0 && text < 0.5) return 0;
    if (text < MIN_SHARED_WORDS && !(distance === 0 && a.class === b.class)) return 0;
    return 0.4 * text + 0.35 * line + 0.25 * (a.class === b.class ? 1 : 0);
}

/**
 * Minimum-cost assignment of rows to columns (Hungarian algorithm with potentials, O(n²m)).
 * `cost` is rows × columns with rows ≤ columns; returns the column of each row.
 */
function assign(cost: number[][]): number[] {
    const n = cost.length;
    const m = n ? cost[0].length : 0;
    const u = new Array<number>(n + 1).fill(0);
    const v = new Array<number>(m + 1).fill(0);
    const p = new Array<number>(m + 1).fill(0);
    const way = new Array<number>(m + 1).fill(0);
    for (let i = 1; i <= n; i++) {
        p[0] = i;
        let j0 = 0;
        const minv = new Array<number>(m + 1).fill(Infinity);
        const used = new Array<boolean>(m + 1).fill(false);
        do {
            used[j0] = true;
            const i0 = p[j0];
            let delta = Infinity;
            let j1 = 0;
            for (let j = 1; j <= m; j++) {
                if (used[j]) continue;
                const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
                if (cur < minv[j]) {
                    minv[j] = cur;
                    way[j] = j0;
                }
                if (minv[j] < delta) {
                    delta = minv[j];
                    j1 = j;
                }
            }
            for (let j = 0; j <= m; j++) {
                if (used[j]) {
                    u[p[j]] += delta;
                    v[j] -= delta;
                } else minv[j] -= delta;
            }
            j0 = j1;
        } while (p[j0] !== 0);
        do {
            const j1 = way[j0];
            p[j0] = p[j1];
            j0 = j1;
        } while (j0);
    }
    const column = new Array<number>(n).fill(-1);
    for (let j = 1; j <= m; j++) if (p[j]) column[p[j] - 1] = j - 1;
    return column;
}

/** One finding as the panel sees it: the item each judge who raised it wrote, in judge order. */
export interface Cluster {
    members: Array<{ judge: string; item: OpenItem }>;
}

const clusterSimilarity = (cluster: Cluster, item: OpenItem) => Math.max(...cluster.members.map(m => similarity(m.item, item)));

/**
 * The judges' items grouped into findings. Judges are taken in order; each judge's items are
 * assigned one-to-one to the findings so far by the Hungarian algorithm (a finding scores as its
 * closest member), never first-fit. An item left over that a finding already holding this judge
 * resembles joins it (one judge split what another named once); any other leftover is a new finding.
 */
export function clusterItems(judges: string[], items: OpenItem[][]): Cluster[] {
    const clusters: Cluster[] = [];
    judges.forEach((judge, j) => {
        const mine = [...items[j]].sort(order);
        const open = clusters.map((c, i) => ({ c, i })).filter(x => !x.c.members.some(m => m.judge === judge));
        const sims = mine.map(item => open.map(x => clusterSimilarity(x.c, item)));
        const placed = new Set<number>();
        if (mine.length && open.length) {
            const transpose = mine.length > open.length;
            const matrix = transpose ? open.map((_, k) => mine.map((__, i) => sims[i][k])) : sims;
            const column = assign(matrix.map(row => row.map(s => (s >= MATCH_THRESHOLD ? 1 - s : 1))));
            column.forEach((col, row) => {
                if (col < 0) return;
                const [i, k] = transpose ? [col, row] : [row, col];
                if (sims[i][k] < MATCH_THRESHOLD) return;
                open[k].c.members.push({ judge, item: mine[i] });
                placed.add(i);
            });
        }
        mine.forEach((item, i) => {
            if (placed.has(i)) return;
            // Only a finding another judge also holds: a judge's own two findings are never merged into one.
            const home = clusters.filter(c => c.members.some(m => m.judge === judge) && c.members.some(m => m.judge !== judge)).map(c => ({ c, s: clusterSimilarity(c, item) }))
                .filter(x => x.s >= MATCH_THRESHOLD).sort((a, b) => b.s - a.s || order(a.c.members[0].item, b.c.members[0].item))[0];
            if (home) home.c.members.push({ judge, item });
            else clusters.push({ members: [{ judge, item }] });
        });
    });
    return clusters;
}

/**
 * Status from every judge's call. Confirmed: a strict majority raised it or confirmed it with
 * evidence. Dropped: refutations with evidence at least match the support and no judge is unsure.
 * Disputed otherwise. With two judges: both raised it, or the other confirmed it; refuted, dropped.
 */
export function statusOf(calls: Record<string, Call>, judges: number): PanelStatus {
    const values = Object.values(calls);
    const support = values.filter(c => c === 'raised' || c === 'confirm').length;
    const refuted = values.filter(c => c === 'refute').length;
    if (support > judges / 2) return 'confirmed';
    if (refuted && refuted >= support && !values.includes('unsure') && !values.includes('not asked')) return 'dropped';
    return 'disputed';
}
