/**
 * The panel measured against the ledger, per judge: which human points each judge raised on its
 * own, how often two judges agree (Cohen's kappa over the ledger's points, where the set of items
 * is fixed, so agreeing on "not raised" is meaningful), and what a caught point cost. A high kappa
 * means the judges share blind spots and a second one adds little; a judge whose catches the others
 * always make too is not earning its runs. This decides one, two or three judges with data.
 */
import type { ReviewerResult } from './reviewer.js';

/** What each judge raised unprompted in one round, with what the round cost. */
export interface JudgeRun {
    judges: string[];
    raised: Array<{ judge: string; file: string; line: number | undefined; text: string }>;
    costUsd?: number;
    runs: number;
}

export interface JudgeCatches {
    judges: string[];
    /** Ledger point ids each judge raised. */
    caught: Record<string, string[]>;
    points: string[];
    costUsd?: number;
    runs: number;
}

/** Each judge's own raises: the panel's record when there was one, else the items tagged with the judge who found them. */
export function judgedFrom(result: ReviewerResult): JudgeRun | undefined {
    if (result.reviewers.length < 2) return undefined;
    const raised: JudgeRun['raised'] = [];
    if (result.panel) {
        for (const d of result.panel) {
            for (const judge of d.judges) {
                const own = d.members?.find(m => m.judge === judge)?.item ?? d.item;
                raised.push({ judge, file: own.file ?? '', line: own.line, text: [own.issue, own.consequence, own.evidence].filter(Boolean).join(' ') });
            }
        }
    } else {
        for (const item of [...result.items, ...result.unverified, ...result.notes]) {
            if (item.kind === 'prior' || !item.reviewer) continue;
            for (const judge of item.reviewer.split('+')) raised.push({ judge, file: item.file ?? '', line: item.line, text: [item.issue, item.consequence, item.evidence].filter(Boolean).join(' ') });
        }
    }
    return { judges: result.reviewers, raised, ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}), runs: result.runs ?? result.reviewers.length };
}

/** Cohen's kappa for two raters' yes/no calls on the same items; 1 when they agree on everything, 0 at chance. */
function cohensKappa(a: boolean[], b: boolean[]): number {
    const n = a.length;
    if (n === 0 || n !== b.length) return Number.NaN;
    const agree = a.filter((x, i) => x === b[i]).length / n;
    const pa = a.filter(Boolean).length / n;
    const pb = b.filter(Boolean).length / n;
    const chance = pa * pb + (1 - pa) * (1 - pb);
    return chance === 1 ? (agree === 1 ? 1 : 0) : (agree - chance) / (1 - chance);
}

/** Across rounds: each judge's catches, every pair's kappa, and the cost of a caught point. */
export function formatJudges(rounds: Array<{ judges?: JudgeCatches; points: Array<{ id: string; caught: boolean }> }>): string {
    const judged = rounds.map(r => r.judges).filter((j): j is JudgeCatches => !!j);
    if (!judged.length) return '';
    const names = [...new Set(judged.flatMap(j => j.judges))];
    const total = judged.reduce((sum, j) => sum + j.points.length, 0);
    const lines = ['', `Judges (${judged.length} round(s), ${total} human point(s))`];
    for (const name of names) {
        const caught = judged.reduce((sum, j) => sum + (j.caught[name]?.length ?? 0), 0);
        const only = judged.reduce((sum, j) => sum + (j.caught[name] ?? []).filter(id => j.judges.filter(o => o !== name).every(o => !(j.caught[o] ?? []).includes(id))).length, 0);
        lines.push(`  ${name}: raised ${caught}/${total}; ${only} that no other judge raised`);
    }
    for (let i = 0; i < names.length; i++) {
        for (let k = i + 1; k < names.length; k++) {
            const both = judged.filter(j => j.judges.includes(names[i]) && j.judges.includes(names[k]));
            const a = both.flatMap(j => j.points.map(p => (j.caught[names[i]] ?? []).includes(p)));
            const b = both.flatMap(j => j.points.map(p => (j.caught[names[k]] ?? []).includes(p)));
            const kappa = cohensKappa(a, b);
            if (a.length) lines.push(`  ${names[i]} and ${names[k]}: kappa ${Number.isNaN(kappa) ? 'n/a' : kappa.toFixed(2)} over ${a.length} point(s)${kappa > 0.8 ? ' (they share blind spots: a second judge adds little)' : ''}`);
        }
    }
    const cost = judged.reduce((sum, j) => sum + (j.costUsd ?? 0), 0);
    const runs = judged.reduce((sum, j) => sum + j.runs, 0);
    const caughtPoints = rounds.filter(r => r.judges).reduce((sum, r) => sum + r.points.filter(p => p.caught).length, 0);
    lines.push(`  ${runs} agent run(s)${cost ? `, $${cost.toFixed(2)} recorded` : ''}${cost && caughtPoints ? `, $${(cost / caughtPoints).toFixed(2)} per caught point` : ''}`);
    return lines.join('\n');
}
