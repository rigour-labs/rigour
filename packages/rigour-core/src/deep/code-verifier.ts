/**
 * Verification for code-aware findings.
 *
 * A finding survives only if it is about code the model was actually shown:
 * the file was sent, it cites a line inside a sent range, and every
 * backticked identifier in the description appears in the sent source.
 * This keeps the "AST grounds the LLM" guarantee when the prompt carries
 * source instead of facts.
 *
 * A line is required. In a backtest of 120 local runs every line-less
 * finding was generic ("does not handle null input") or not a defect at
 * all ("the code is well-structured"), and nothing can be verified about it.
 */
import type { DeepFinding } from '../inference/types.js';
import type { CodeContext } from './code-context.js';
import type { VerifiedFinding } from './verifier.js';

const MIN_CONFIDENCE = 0.3;

export function verifyCodeFindings(findings: DeepFinding[], contexts: CodeContext[]): VerifiedFinding[] {
    const verified: VerifiedFinding[] = [];
    for (const finding of findings) {
        const context = findContext(finding.file, contexts);
        if (!context) continue;
        const note = rejectionReason(finding, context);
        if (note) continue;
        verified.push({ ...finding, file: context.file, verified: true, verificationNotes: 'grounded in sent source' });
    }
    return verified;
}

function rejectionReason(finding: DeepFinding, context: CodeContext): string | null {
    if (finding.confidence < MIN_CONFIDENCE) return 'low confidence';
    const line = typeof finding.line === 'number' && finding.line > 0 ? finding.line : null;
    if (line === null) return 'no line';
    if (!context.ranges.some(([s, e]) => line >= s && line <= e)) return 'line outside sent source';
    const missing = quotedIdentifiers(finding.description).find(id => !context.source.includes(id));
    if (missing) return `identifier \`${missing}\` not in sent source`;
    return null;
}

/** Backticked, identifier-like tokens (skips quoted prose and code fragments). */
export function quotedIdentifiers(text: string): string[] {
    const ids: string[] = [];
    for (const match of text.matchAll(/`([^`\n]+)`/g)) {
        const token = match[1].trim();
        if (/^[A-Za-z_$][\w$.]*(\(\))?$/.test(token)) ids.push(token.replace(/\(\)$/, ''));
    }
    return ids;
}

function findContext(file: string, contexts: CodeContext[]): CodeContext | null {
    const normalized = file.replace(/\\/g, '/').replace(/^\.\//, '');
    const exact = contexts.find(c => c.file === normalized);
    if (exact) return exact;
    const bySuffix = contexts.filter(c => c.file.endsWith('/' + normalized) || normalized.endsWith('/' + c.file));
    if (bySuffix.length === 1) return bySuffix[0];
    // A single-file review may be reported by basename only.
    return contexts.length === 1 && contexts[0].file.split('/').pop() === normalized.split('/').pop() ? contexts[0] : null;
}
