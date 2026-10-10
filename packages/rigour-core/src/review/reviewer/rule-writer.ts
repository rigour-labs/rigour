/**
 * The model call behind turning reviews into rules (review-learning/rules-from-reviews.ts): the
 * team's first installed reviewer CLI, isolated and read-only exactly as a judge is, its spend
 * counted with the reviewer's and stopped by the same caps (caps.ts): the day's runs and dollars, and
 * max_usd_per_review for one rule-writing run. No CLI, or a cap reached: undefined, and the points stay
 * as the person wrote them.
 */
import type { Config } from '../../types/index.js';
import type { RuleWriter } from '../../review-learning/rules-from-reviews.js';
import { ADAPTERS, isReviewerName, resolveAdapter } from './adapters.js';
import type { Exec } from './exec.js';
import { judgeUnset } from './judge-env.js';
import { resolveReviewer } from './settings.js';
import { VerdictStore } from './store.js';
import { overBudget } from './caps.js';

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
    let spent = 0; // this rule-writing run, against max_usd_per_review
    return async prompt => {
        const capped = overBudget(store.spend(), settings, 1, spent);
        if (capped) {
            progress(`rules from reviews: ${capped}; the rest stay as people wrote them`);
            return undefined;
        }
        const run = await exec(binary, ADAPTERS[name].args(prompt, model), { cwd, timeoutMs: settings.timeout_ms, unset: judgeUnset(name, settings.judge_env) });
        const answer = ADAPTERS[name].answer(run.stdout);
        store.addSpend(1, answer.costUsd);
        spent += answer.costUsd ?? 0;
        return run.exitCode === 0 ? answer.text : undefined;
    };
}
