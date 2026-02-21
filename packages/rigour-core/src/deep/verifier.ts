/**
 * LLM Verification Layer — Step 3 of the three-step pipeline.
 * AST verifies that LLM findings reference real code entities.
 * Drops hallucinated findings, tags verified ones.
 */
import type { DeepFinding } from '../inference/types.js';
import type { FileFacts } from './fact-extractor.js';
import { Logger } from '../utils/logger.js';

export interface VerifiedFinding extends DeepFinding {
    verified: boolean;
    verificationNotes?: string;
}

/**
 * Verify LLM findings against AST-extracted facts.
 * Returns only findings that pass verification.
 */
export function verifyFindings(
    findings: DeepFinding[],
    facts: FileFacts[]
): VerifiedFinding[] {
    const factsByPath = new Map<string, FileFacts>();
    for (const f of facts) {
        factsByPath.set(f.path, f);
    }

    const verified: VerifiedFinding[] = [];

    for (const finding of findings) {
        const result = verifyFinding(finding, factsByPath);
        if (result.verified) {
            verified.push(result);
        } else {
            Logger.debug(`Dropped unverified finding: ${finding.category} in ${finding.file} — ${result.verificationNotes}`);
        }
    }

    return verified;
}

function verifyFinding(
    finding: DeepFinding,
    factsByPath: Map<string, FileFacts>
): VerifiedFinding {
    // Check 1: Does the referenced file exist in facts?
    const fileFacts = findFile(finding.file, factsByPath);
    if (!fileFacts) {
        return {
            ...finding,
            verified: false,
            verificationNotes: `File not found in analyzed files: ${finding.file}`,
        };
    }

    // Check 2: Category-specific verification
    switch (finding.category) {
        case 'god_class':
        case 'srp_violation':
        case 'ocp_violation':
        case 'lsp_violation':
        case 'isp_violation':
        case 'dip_violation':
            return verifyClassFinding(finding, fileFacts);

        case 'god_function':
        case 'long_params':
            return verifyFunctionFinding(finding, fileFacts);

        case 'empty_catch':
        case 'error_inconsistency':
            return verifyErrorHandlingFinding(finding, fileFacts);

        case 'dry_violation':
        case 'data_clump':
        case 'feature_envy':
        case 'shotgun_surgery':
        case 'inappropriate_intimacy':
        case 'architecture':
        case 'language_idiom':
        case 'code_smell':
        case 'test_quality':
            // These are harder to verify mechanically — accept if file exists
            // and confidence is reasonable
            return {
                ...finding,
                verified: finding.confidence >= 0.3,
                verificationNotes: finding.confidence < 0.3 ? 'Low confidence' : 'File exists, accepted',
            };

        default:
            // Unknown category — accept if file exists
            return {
                ...finding,
                verified: true,
                verificationNotes: 'Unknown category, file exists',
            };
    }
}

function verifyClassFinding(finding: DeepFinding, facts: FileFacts): VerifiedFinding {
    // Try to find the referenced class name in the description
    const className = extractEntityName(finding.description, facts.classes.map(c => c.name));

    if (!className) {
        // Class name not mentioned or not found — still accept if description references the file
        return {
            ...finding,
            verified: facts.classes.length > 0,
            verificationNotes: facts.classes.length > 0
                ? 'File has classes, accepted'
                : 'No classes found in file',
        };
    }

    const cls = facts.classes.find(c => c.name === className);
    if (!cls) {
        return {
            ...finding,
            verified: false,
            verificationNotes: `Class "${className}" not found in ${facts.path}`,
        };
    }

    // Additional checks for specific categories
    if (finding.category === 'god_class' || finding.category === 'srp_violation') {
        // Verify: class actually has many methods (5+ is reasonable threshold)
        if (cls.methodCount < 5) {
            return {
                ...finding,
                verified: false,
                verificationNotes: `Class "${className}" only has ${cls.methodCount} methods — unlikely god class (threshold: 5+)`,
            };
        }
    }

    return {
        ...finding,
        verified: true,
        verificationNotes: `Class "${className}" verified (${cls.methodCount} methods, ${cls.lineCount} lines)`,
    };
}

function verifyFunctionFinding(finding: DeepFinding, facts: FileFacts): VerifiedFinding {
    const funcName = extractEntityName(finding.description, facts.functions.map(f => f.name));

    if (!funcName) {
        return {
            ...finding,
            verified: facts.functions.length > 0,
            verificationNotes: facts.functions.length > 0 ? 'File has functions, accepted' : 'No functions found',
        };
    }

    const func = facts.functions.find(f => f.name === funcName);
    if (!func) {
        return {
            ...finding,
            verified: false,
            verificationNotes: `Function "${funcName}" not found in ${facts.path}`,
        };
    }

    // God function: verify it's actually long
    if (finding.category === 'god_function') {
        if (func.lineCount < 30) {
            return {
                ...finding,
                verified: false,
                verificationNotes: `Function "${funcName}" is only ${func.lineCount} lines — not a god function`,
            };
        }
    }

    // Long params: verify param count
    if (finding.category === 'long_params') {
        if (func.paramCount < 4) {
            return {
                ...finding,
                verified: false,
                verificationNotes: `Function "${funcName}" only has ${func.paramCount} params`,
            };
        }
    }

    return {
        ...finding,
        verified: true,
        verificationNotes: `Function "${funcName}" verified (${func.lineCount} lines, ${func.paramCount} params)`,
    };
}

function verifyErrorHandlingFinding(finding: DeepFinding, facts: FileFacts): VerifiedFinding {
    if (facts.errorHandling.length === 0) {
        return {
            ...finding,
            verified: false,
            verificationNotes: 'No error handling found in file',
        };
    }

    if (finding.category === 'empty_catch') {
        const hasEmpty = facts.errorHandling.some(e => e.isEmpty);
        return {
            ...finding,
            verified: hasEmpty,
            verificationNotes: hasEmpty ? 'Empty catch blocks confirmed' : 'No empty catches found',
        };
    }

    // Error inconsistency: verify multiple strategies exist
    const strategies = new Set(facts.errorHandling.map(e => e.strategy));
    return {
        ...finding,
        verified: strategies.size >= 2,
        verificationNotes: `${strategies.size} error strategies found: ${[...strategies].join(', ')}`,
    };
}

/**
 * Try to find a known entity name referenced in a description string.
 */
function extractEntityName(description: string, knownNames: string[]): string | null {
    // Sort by length (longest first) to match most specific name
    const sorted = [...knownNames].sort((a, b) => b.length - a.length);

    for (const name of sorted) {
        if (description.includes(name)) {
            return name;
        }
    }

    return null;
}

/**
 * Find a file in the facts map, handling path normalization.
 * Uses strict matching first, falling back to partial path matching.
 * Avoids ambiguous filename-only matches (e.g., "index.ts" matching many files).
 */
function findFile(filePath: string, factsByPath: Map<string, FileFacts>): FileFacts | null {
    // Direct match
    if (factsByPath.has(filePath)) return factsByPath.get(filePath)!;

    // Strip leading ./
    const normalized = filePath.replace(/^\.\//, '');
    if (factsByPath.has(normalized)) return factsByPath.get(normalized)!;

    // Try suffix match — require at least one directory segment to avoid ambiguity.
    // e.g., "services/auth.ts" matches "src/services/auth.ts" but bare "auth.ts" won't
    // match if there's "src/auth.ts" AND "lib/auth.ts".
    const parts = normalized.split('/');
    if (parts.length >= 2) {
        // Has directory info — safe to do endsWith match
        for (const [key, value] of factsByPath) {
            if (key.endsWith('/' + normalized) || key === normalized) {
                return value;
            }
        }
    } else {
        // Bare filename — only match if exactly one file has that name
        const fileName = parts[0];
        const matches: FileFacts[] = [];
        for (const [key, value] of factsByPath) {
            if (key.endsWith('/' + fileName) || key === fileName) {
                matches.push(value);
            }
        }
        if (matches.length === 1) return matches[0];
        // Ambiguous (multiple files with same name) — return null
    }

    return null;
}
