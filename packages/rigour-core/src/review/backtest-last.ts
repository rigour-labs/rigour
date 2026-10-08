/**
 * `rigour backtest --last N`: the front door. The last N merged pull requests become a ledger on
 * their own (one round per review by a person, from the inline comments, plus the head a person
 * approved), the review runs on each with that review hidden, and the report leads with the two
 * numbers a team needs before trusting a reviewer: blocks on heads the seniors approved (must be
 * about none, and said first when it is not), and points people raised later that the review had
 * already blocked, with how many rounds earlier. Then cost and time. Nothing is published; the
 * ledger it built is written beside the hand-made one for a person to read.
 */
import fs from 'fs';
import path from 'path';
import type { Config } from '../types/index.js';
import { defaultExec, type Exec, type Progress } from './reviewer/exec.js';
import { matches, runBacktest, type BacktestItem, type BacktestOptions, type Ledger, type LedgerRound, type RoundResult } from './backtest.js';
import { mergedPrs, roundsForPr } from './backtest-init.js';

export const LAST_LEDGER_PATH = '.rigour/backtest-last.json';
const GIT_TIMEOUT_MS = 5 * 60_000;

export interface EarlyCatch { pr: number; round: string; point: string; by: string; roundsEarlier: number }

export interface LastReport {
    prs: number;
    rounds: number;
    approvedHeads: number;
    /** Blocking items on heads a person approved: every one is a false block. */
    blocksOnApproved: Array<{ pr: number; round: string; item: BacktestItem }>;
    /** Points a person raised in a later round that an earlier round had already blocked. */
    early: EarlyCatch[];
    /** Points caught in the round they were raised. */
    sameRound: number;
    /** Points raised after a pull request's first review: the pool `early` is drawn from. */
    pointsLater: number;
    /** Rounds whose commit is no longer reachable (a force-push), with why. */
    skipped: string[];
    costUsd?: number;
    durationMs: number;
    results: RoundResult[];
}

export interface LastOptions extends Pick<BacktestOptions, 'reviewer' | 'exec' | 'progress' | 'collect'> {
    last: number;
}

export async function backtestLast(cwd: string, config: Config, options: LastOptions): Promise<LastReport> {
    const exec = options.exec ?? defaultExec;
    const progress: Progress = options.progress ?? (() => undefined);
    const prs = await mergedPrs(cwd, options.last, config, exec);
    const rounds: LedgerRound[] = [];
    const skipped: string[] = [];
    for (const pr of prs) {
        // The reviewed commits must be here: a pull request's head is fetched once; a round force-pushed away is skipped, not guessed.
        await exec('git', ['fetch', '-q', 'origin', `pull/${pr.number}/head`], { cwd, timeoutMs: GIT_TIMEOUT_MS });
        let found;
        try {
            found = await roundsForPr(cwd, pr.number, config, exec, { approvedHead: true });
        } catch (error) {
            skipped.push(`pull request ${pr.number}: ${error instanceof Error ? error.message : String(error)}`);
            continue;
        }
        for (const round of [...found.rounds, ...(found.approved ? [found.approved] : [])]) {
            const present = await exec('git', ['rev-parse', '--verify', '-q', `${round.commit}^{commit}`], { cwd, timeoutMs: GIT_TIMEOUT_MS });
            if (present.exitCode !== 0) {
                skipped.push(`${round.id}: commit ${round.commit.slice(0, 9)} is not reachable (force-pushed away)`);
                continue;
            }
            // Unattended: only points with a file and a line window; a body point would need a person's pattern.
            rounds.push({ ...round, points: round.points.filter(p => !p.needs && p.file && p.lines) });
        }
    }
    if (rounds.length === 0) throw new Error(`none of the last ${options.last} merged pull requests has a review by a person whose commits are reachable${skipped.length ? `:\n  ${skipped.join('\n  ')}` : ''}`);
    const ledger: Ledger = { rounds };
    fs.mkdirSync(path.join(cwd, path.dirname(LAST_LEDGER_PATH)), { recursive: true });
    fs.writeFileSync(path.join(cwd, LAST_LEDGER_PATH), JSON.stringify(ledger, null, 2));
    progress(`backtest: ${rounds.length} round(s) from ${prs.length} merged pull request(s), ledger written to ${LAST_LEDGER_PATH}`);
    const results = await runBacktest(cwd, config, ledger, { reviewer: options.reviewer, exec, progress, collect: options.collect });
    return { ...scoreLast(ledger, results), skipped };
}

/** The report's numbers from a ledger and its results: pure, so a change to the scoring is measured by tests. */
export function scoreLast(ledger: Ledger, results: RoundResult[]): Omit<LastReport, 'skipped'> {
    const byPr = new Map<number, LedgerRound[]>();
    for (const round of ledger.rounds) if (round.pr !== undefined) byPr.set(round.pr, [...(byPr.get(round.pr) ?? []), round]);
    const resultOf = new Map(results.map(r => [r.round, r]));
    const early: EarlyCatch[] = [];
    let pointsLater = 0;
    for (const [pr, prRounds] of byPr) {
        const reviews = prRounds.filter(r => !r.id.endsWith('-approved')).sort((a, b) => ((a.reviewed_at ?? '') < (b.reviewed_at ?? '') ? -1 : 1));
        for (let j = 1; j < reviews.length; j++) {
            for (const point of reviews[j].points) {
                pointsLater++;
                for (let i = 0; i < j; i++) {
                    const hit = resultOf.get(reviews[i].id)?.items.find(item => item.blocking && matches(point, item));
                    if (hit) {
                        early.push({ pr, round: reviews[i].id, point: point.point, by: `${hit.gate} ${hit.file}${hit.line ? `:${hit.line}` : ''}`, roundsEarlier: j - i });
                        break;
                    }
                }
            }
        }
    }
    const approvedRounds = ledger.rounds.filter(r => r.id.endsWith('-approved'));
    const blocksOnApproved = approvedRounds.flatMap(r => (resultOf.get(r.id)?.items ?? []).filter(i => i.blocking).map(item => ({ pr: r.pr ?? 0, round: r.id, item })));
    const costs = results.map(r => r.costUsd).filter((c): c is number => typeof c === 'number');
    return {
        prs: byPr.size,
        rounds: ledger.rounds.length,
        approvedHeads: approvedRounds.length,
        blocksOnApproved,
        early,
        sameRound: results.reduce((n, r) => n + r.points.filter(p => p.caught).length, 0),
        pointsLater,
        ...(costs.length ? { costUsd: costs.reduce((a, b) => a + b, 0) } : {}),
        durationMs: results.reduce((n, r) => n + r.durationMs, 0),
        results,
    };
}

/** The two numbers first, the worse one on top; then what they rest on. */
export function formatLast(r: LastReport): string {
    const lines: string[] = [];
    const approved = r.blocksOnApproved.length === 0
        ? `0 blocking items on ${r.approvedHeads} approved head(s).`
        : `${r.blocksOnApproved.length} blocking item(s) on ${r.approvedHeads} approved head(s): every one is a block the team would have overridden.`;
    const earlyLine = `${r.early.length} of ${r.pointsLater} point(s) people raised in a later round were already blocked${r.early.length ? `, ${(r.early.reduce((n, e) => n + e.roundsEarlier, 0) / r.early.length).toFixed(1)} round(s) earlier on average` : ''}.`;
    if (r.blocksOnApproved.length) {
        lines.push(approved);
        for (const b of r.blocksOnApproved) lines.push(`  ${b.round}: ${b.item.gate} ${b.item.file}${b.item.line ? `:${b.item.line}` : ''} ${b.item.text.slice(0, 140)}`);
        lines.push(earlyLine);
    } else {
        lines.push(earlyLine, approved);
    }
    for (const e of r.early) lines.push(`  pr ${e.pr}, ${e.round}: "${e.point.slice(0, 100)}" blocked ${e.roundsEarlier} round(s) earlier by ${e.by}`);
    lines.push(`${r.sameRound} point(s) caught in the round they were raised. ${r.prs} pull request(s), ${r.rounds} round(s)${r.costUsd !== undefined ? `, $${r.costUsd.toFixed(2)}` : ''}, ${Math.round(r.durationMs / 1000)} s.`);
    for (const s of r.skipped) lines.push(`skipped ${s}`);
    lines.push(`The ledger it ran is in ${LAST_LEDGER_PATH}; nothing was sent anywhere.`);
    return lines.join('\n');
}
