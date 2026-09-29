/**
 * Learned rules (`.rigour/rules/*.json`) as Studio shows them: what each
 * rule checks, where it came from, and the validation that let it in.
 */
import { loadLearnedRules, type LearnedRule } from '@rigour-labs/core';

export interface StudioLearnedRule {
    id: string;
    template: LearnedRule['pattern']['template'];
    /** e.g. "`redirect` in argument 2" or "`cache-control` conditional on `stepsAvailable`". */
    requirement: string;
    /** e.g. "declaration scripts/http.ts#HttpDeps.fetch" or "regression guard for GET>respond in route.ts". */
    appliesTo: string;
    message: string;
    severity: LearnedRule['severity'];
    source: LearnedRule['source'];
    validation: LearnedRule['validation'];
}

export function loadStudioLearnedRules(cwd: string): StudioLearnedRule[] {
    return loadLearnedRules(cwd).map(toStudioRule);
}

export function toStudioRule(rule: LearnedRule): StudioLearnedRule {
    const { pattern } = rule;
    const requirement = pattern.template === 'require-option'
        ? `\`${pattern.property}\` in argument ${pattern.argIndex + 1}`
        : `\`${pattern.property}\` conditional on \`${pattern.guard}\``;
    const appliesTo = pattern.scope
        ? `regression guard for ${pattern.scope.fn} in ${pattern.scope.file}`
        : `${pattern.callee.level} ${pattern.callee.key}`;
    return {
        id: rule.id, template: pattern.template, requirement, appliesTo,
        message: rule.message, severity: rule.severity, source: rule.source, validation: rule.validation,
    };
}
