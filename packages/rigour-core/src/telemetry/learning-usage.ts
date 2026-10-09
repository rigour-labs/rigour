/**
 * What the learning loop did in a repository, for opt-in telemetry: read from the two places that already say it, the
 * switches' resolver and the outcome numbers (outcomes/metrics.ts), never counted again here. Enums and counts only; a
 * rate only where outcomeMetrics gives one (ten or more records), else none.
 */
import type { Config } from '../types/index.js';
import { resolveSwitch, SWITCHES, type SwitchName } from '../switches.js';
import { localOutcomeMetrics } from '../outcomes/run.js';
import type { Share } from '../outcomes/metrics.js';

export function learningUsage(cwd: string, config: Config): Record<string, unknown> {
    const usage: Record<string, unknown> = {};
    for (const name of Object.keys(SWITCHES) as SwitchName[]) {
        const resolved = resolveSwitch(name, config);
        usage[`switch_${name}`] = resolved.required ? 'required' : resolved.enabled ? 'on' : 'off';
        usage[`switch_${name}_set_by`] = resolved.source; // team (rigour.yml), user (personal settings), env or flag
    }
    const metrics = localOutcomeMetrics(cwd);
    if (!metrics) return usage;
    const share = (prefix: string, s: Share) => {
        usage[`${prefix}_count`] = s.count;
        usage[`${prefix}_of`] = s.of;
        if (s.rate !== null) usage[`${prefix}_rate`] = s.rate;
    };
    usage.outcomes_merged = metrics.records.merged;
    usage.outcomes_settled = metrics.records.settled;
    share('outcomes_ci_regressed', metrics.settled.ciRegressed);
    share('outcomes_reverted', metrics.settled.reverted);
    share('outcomes_fixed_later', metrics.settled.fixedLater);
    usage.outcomes_reviewed_prs = metrics.settled.reviewed.prs;
    share('outcomes_reviewed_fixed_later', metrics.settled.reviewed.fixedLater);
    usage.outcomes_not_reviewed_prs = metrics.settled.notReviewed.prs;
    share('outcomes_not_reviewed_fixed_later', metrics.settled.notReviewed.fixedLater);
    usage.lessons_awaiting_decision = metrics.lessons.awaitingDecision;
    usage.lessons_promoted_from_evidence = metrics.lessons.promotedFromEvidence;
    usage.lessons_dismissed = metrics.lessons.dismissed;
    usage.lessons_taken_back = metrics.lessons.takenBack;
    return usage;
}
