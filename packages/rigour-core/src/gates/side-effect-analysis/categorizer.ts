/**
 * Side Effect Categorization and Severity Assignment
 *
 * Functions that classify side effects by type/severity and assign
 * appropriate titles and descriptions.
 */

import { SideEffectViolation } from '../side-effect-helpers/index.js';
import { Failure } from '../../types/index.js';

/**
 * Categorization information for each rule type
 */
const RULE_TITLES: Record<string, string> = {
    'unbounded-timer': 'Unbounded Timer',
    'orphan-process': 'Orphan Process',
    'unbounded-io-loop': 'Unbounded I/O Loop',
    'retry-without-limit': 'Retry Without Limit',
    'circular-trigger': 'Circular File Trigger',
    'resource-leak': 'Resource Leak',
    'unbounded-recursion': 'Unbounded Recursion',
    'auto-restart-bomb': 'Auto-Restart Bomb',
};

/**
 * Maps rule IDs to their severity categories
 */
const RULE_SEVERITIES: Record<string, 'low' | 'medium' | 'high' | 'critical'> = {
    'unbounded-timer': 'high',
    'orphan-process': 'high',
    'unbounded-io-loop': 'critical',
    'retry-without-limit': 'high',
    'circular-trigger': 'critical',
    'resource-leak': 'medium',
    'unbounded-recursion': 'high',
    'auto-restart-bomb': 'critical',
};

/**
 * Gets the human-readable title for a rule
 */
export function getRuleTitle(rule: string): string {
    return RULE_TITLES[rule] || rule;
}

/**
 * Gets the severity level for a rule
 */
export function getRuleSeverity(rule: string): 'low' | 'medium' | 'high' | 'critical' {
    return RULE_SEVERITIES[rule] || 'medium';
}

/**
 * Categorizes a violation and assigns it proper severity and title
 */
export function categorizeViolation(violation: SideEffectViolation): SideEffectViolation {
    // Override severity if necessary (already set in violation)
    return violation;
}

/**
 * Converts a side effect violation to a Failure object
 */
export function violationToFailure(
    violation: SideEffectViolation,
    createFailure: (
        message: string,
        files: string[],
        hint?: string,
        title?: string,
        startLine?: number,
        endLine?: number,
        severity?: string,
    ) => Failure,
): Failure {
    return createFailure(
        violation.description,
        [violation.file],
        violation.hint,
        `Side-Effect: ${getRuleTitle(violation.rule)}`,
        violation.line,
        violation.line,
        violation.severity,
    );
}

/**
 * Groups violations by severity level
 */
export function groupBySeverity(
    violations: SideEffectViolation[],
): Record<string, SideEffectViolation[]> {
    const grouped: Record<string, SideEffectViolation[]> = {
        critical: [],
        high: [],
        medium: [],
        low: [],
    };

    for (const violation of violations) {
        const severity = violation.severity as string;
        if (severity in grouped) {
            grouped[severity].push(violation);
        }
    }

    return grouped;
}

/**
 * Filters violations by severity threshold
 */
export function filterBySeverity(
    violations: SideEffectViolation[],
    minSeverity: 'critical' | 'high' | 'medium' | 'low',
): SideEffectViolation[] {
    const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    const minLevel = severityOrder[minSeverity];

    return violations.filter(
        v => severityOrder[v.severity as keyof typeof severityOrder] <= minLevel,
    );
}
