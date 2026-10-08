/**
 * The model call behind turning reviews into rules (review-learning/rules-from-reviews.ts): the
 * team's first installed reviewer CLI, isolated and read-only exactly as a judge is, its spend
 * counted with the reviewer's and stopped at review.reviewer.max_usd_per_day. No CLI, or the cap
 * reached: undefined, and the points stay as the person wrote them.
 */
import type { Config } from '../../types/index.js';
import type { RuleWriter } from '../../review-learning/rules-from-reviews.js';
import { ADAPTERS, isReviewerName, resolveAdapter } from './adapters.js';
import type { Exec } from './exec.js';
import { judgeUnset } from './judge-env.js';
import { resolveReviewer } from './settings.js';
import { VerdictStore } from './store.js';

export async function ruleWriterFor(cwd: string, config: Config, exec: Exec, progress: (line: string) => void = () => undefined): Promise<RuleWriter | undefined> {
    const settings = resolveReviewer(config);
    let chosen: { name: keyof typeof ADAPTERS; binary: string } | undefined;
    for (const name of settings.reviewers.filter(isReviewerName)) {
        const found = await resolveAdapter(ADAPTERS[name], cwd, exec);
        if (found) {
            chosen = { name, binary: found.binary };
            break;
        }
    }
    const store = await VerdictStore.open(cwd, exec);
    if (!chosen || !store) return undefined;
    const { name, binary } = chosen;
    const model = settings.models[name] ?? (name === 'claude' ? settings.model : undefined);
    return async prompt => {
        if (settings.max_usd_per_day !== undefined && store.spend().usd >= settings.max_usd_per_day) {
            progress(`rules from reviews: the daily cost cap ($${settings.max_usd_per_day}) is reached; the rest stay as people wrote them`);
            return undefined;
        }
        const run = await exec(binary, ADAPTERS[name].args(prompt, model), { cwd, timeoutMs: settings.timeout_ms, unset: judgeUnset(name, settings.judge_env) });
        const answer = ADAPTERS[name].answer(run.stdout);
        store.addSpend(1, answer.costUsd);
        return run.exitCode === 0 ? answer.text : undefined;
    };
}
