/**
 * Parse an LLM response into structured findings.
 *
 * Handles raw JSON, markdown-wrapped JSON, a findings object embedded in
 * prose, and truncated responses (the model hit its token budget mid-array).
 */
import type { DeepFinding } from '../inference/types.js';
import { Logger } from '../utils/logger.js';

const VALID_SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];
const FINDING_OBJECT = /\{\s*"category"\s*:\s*"[^"]+"\s*,[\s\S]*?"description"\s*:\s*"[^"]*"[^}]*\}/g;

export function parseFindings(response: string): DeepFinding[] {
    if (!response || response.trim().length === 0) {
        Logger.warn('Empty LLM response received');
        return [];
    }

    const candidates = [
        response,
        response.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1],
        response.match(/\{[\s\S]*"findings"[\s\S]*\}/)?.[0],
    ];
    for (const candidate of candidates) {
        const parsed = candidate === undefined ? null : tryParseFindings(candidate);
        if (parsed) return parsed;
    }

    const recovered = recoverTruncatedFindings(response);
    if (recovered.length > 0) {
        Logger.info(`Recovered ${recovered.length} findings from truncated response`);
        return recovered;
    }

    Logger.warn(`Could not parse LLM response as findings JSON. First 200 chars: ${response.substring(0, 200)}`);
    return [];
}

function tryParseFindings(text: string): DeepFinding[] | null {
    try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed?.findings)) return validateFindings(parsed.findings);
        if (Array.isArray(parsed)) return validateFindings(parsed);
        return [];
    } catch {
        return null;
    }
}

/** Extract the complete finding objects from a response cut off mid-array. */
export function recoverTruncatedFindings(response: string): DeepFinding[] {
    const findings: unknown[] = [];
    for (const match of response.matchAll(FINDING_OBJECT)) {
        try {
            findings.push(JSON.parse(match[0]));
        } catch {
            // The object itself was truncated; skip it.
        }
    }
    return validateFindings(findings);
}

/** Drop malformed entries and normalise confidence and severity. */
export function validateFindings(raw: unknown[]): DeepFinding[] {
    return raw.filter(hasRequiredFields).map(normalizeFinding);
}

function hasRequiredFields(f: any): f is DeepFinding {
    return !!f && typeof f === 'object'
        && isNonEmptyString(f.category)
        && isNonEmptyString(f.file)
        && isNonEmptyString(f.description);
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0;
}

function normalizeFinding(f: DeepFinding): DeepFinding {
    const confidenceOk = typeof f.confidence === 'number' && f.confidence >= 0 && f.confidence <= 1;
    return {
        ...f,
        confidence: confidenceOk ? f.confidence : 0.5,
        severity: VALID_SEVERITIES.includes(f.severity) ? f.severity : 'medium',
    };
}
