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
        // ── Class/Struct-based categories ──
        case 'god_class':
        case 'srp_violation':
        case 'ocp_violation':
        case 'lsp_violation':
        case 'isp_violation':
        case 'dip_violation':
            return verifyClassOrStructFinding(finding, fileFacts);

        // ── Function-based categories ──
        case 'god_function':
        case 'long_params':
        case 'complex_conditional':
            return verifyFunctionFinding(finding, fileFacts);

        // ── Error handling categories ──
        case 'empty_catch':
        case 'error_inconsistency':
        case 'error_swallowing':
        case 'missing_error_check':
        case 'panic_in_library':
            return verifyErrorHandlingFinding(finding, fileFacts);

        // ── Interface categories (Go-specific) ──
        case 'isp_violation_interface':
            return verifyInterfaceFinding(finding, fileFacts);

        // ── Concurrency categories ──
        case 'race_condition':
        case 'goroutine_leak':
        case 'missing_context':
        case 'channel_misuse':
        case 'mutex_scope':
            return verifyConcurrencyFinding(finding, fileFacts);

        // ── Test categories ──
        case 'test_quality':
        case 'test_coupling':
        case 'test_duplication':
        case 'missing_test':
            return verifyTestFinding(finding, fileFacts);

        // ── File-level categories (verified by file existence + basic checks) ──
        case 'long_file':
            return {
                ...finding,
                verified: fileFacts.lineCount > 300,
                verificationNotes: fileFacts.lineCount > 300
                    ? `File is ${fileFacts.lineCount} lines`
                    : `File is only ${fileFacts.lineCount} lines`,
            };

        case 'magic_number':
            return {
                ...finding,
                verified: (fileFacts.magicNumbers || 0) > 3,
                verificationNotes: `${fileFacts.magicNumbers || 0} magic numbers detected`,
            };

        case 'resource_leak':
            // For Go: check defers vs resource operations
            if (fileFacts.language === 'go') {
                const hasResources = fileFacts.imports.some(i =>
                    i.includes('os') || i.includes('net') || i.includes('http') || i.includes('io') || i.includes('sql')
                );
                return {
                    ...finding,
                    verified: hasResources && finding.confidence >= 0.4,
                    verificationNotes: hasResources ? 'File imports resource packages' : 'No resource imports found',
                };
            }
            return { ...finding, verified: finding.confidence >= 0.4, verificationNotes: 'Accepted on confidence' };

        // ── Categories verified by file existence + reasonable confidence ──
        case 'dry_violation':
        case 'copy_paste_code':
        case 'data_clump':
        case 'feature_envy':
        case 'shotgun_surgery':
        case 'inappropriate_intimacy':
        case 'primitive_obsession':
        case 'lazy_class':
        case 'speculative_generality':
        case 'refused_bequest':
        case 'architecture':
        case 'circular_dependency':
        case 'package_cohesion':
        case 'api_design':
        case 'missing_abstraction':
        case 'language_idiom':
        case 'naming_convention':
        case 'dead_code':
        case 'code_smell':
        case 'performance':
        case 'hardcoded_config':
            return {
                ...finding,
                verified: finding.confidence >= 0.3,
                verificationNotes: finding.confidence < 0.3 ? 'Low confidence' : 'File exists, accepted',
            };

        default:
            // Unknown category — accept if file exists and confidence is reasonable
            return {
                ...finding,
                verified: finding.confidence >= 0.3,
                verificationNotes: 'Unknown category, accepted on confidence',
            };
    }
}

/**
 * Verify class OR struct-based findings.
 * For Go: uses structs instead of classes.
 */
function verifyClassOrStructFinding(finding: DeepFinding, facts: FileFacts): VerifiedFinding {
    // Combine classes and structs for verification
    const entities = [
        ...facts.classes.map(c => ({ name: c.name, methodCount: c.methodCount, lineCount: c.lineCount, methods: c.methods })),
        ...(facts.structs || []).map(s => ({ name: s.name, methodCount: s.methodCount, lineCount: s.lineCount, methods: s.methods })),
    ];

    if (entities.length === 0) {
        // No classes or structs but file exists — for Go, check if file has many functions
        // which effectively makes it a "god module"
        if (facts.language === 'go' && facts.functions.length >= 8) {
            return {
                ...finding,
                verified: true,
                verificationNotes: `Go file with ${facts.functions.length} functions — module-level issue accepted`,
            };
        }
        return {
            ...finding,
            verified: false,
            verificationNotes: 'No classes or structs found in file',
        };
    }

    // Try to find the referenced entity name
    const entityName = extractEntityName(finding.description, entities.map(e => e.name));

    if (!entityName) {
        // Entity not named but file has classes/structs — accept if reasonable
        return {
            ...finding,
            verified: entities.length > 0 && finding.confidence >= 0.4,
            verificationNotes: entities.length > 0 ? 'File has entities, accepted' : 'No entities found',
        };
    }

    const entity = entities.find(e => e.name === entityName);
    if (!entity) {
        return {
            ...finding,
            verified: false,
            verificationNotes: `Entity "${entityName}" not found in ${facts.path}`,
        };
    }

    // Category-specific thresholds
    if (finding.category === 'god_class' || finding.category === 'srp_violation') {
        if (entity.methodCount < 5 && entity.lineCount < 200) {
            return {
                ...finding,
                verified: false,
                verificationNotes: `"${entityName}" has ${entity.methodCount} methods, ${entity.lineCount} lines — below god class threshold`,
            };
        }
    }

    return {
        ...finding,
        verified: true,
        verificationNotes: `"${entityName}" verified (${entity.methodCount} methods, ${entity.lineCount} lines)`,
    };
}

function verifyFunctionFinding(finding: DeepFinding, facts: FileFacts): VerifiedFinding {
    const funcName = extractEntityName(finding.description, facts.functions.map(f => f.name));

    if (!funcName) {
        return {
            ...finding,
            verified: facts.functions.length > 0 && finding.confidence >= 0.4,
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

    if (finding.category === 'god_function') {
        if (func.lineCount < 30) {
            return {
                ...finding,
                verified: false,
                verificationNotes: `Function "${funcName}" is only ${func.lineCount} lines — not a god function`,
            };
        }
    }

    if (finding.category === 'long_params') {
        if (func.paramCount < 4) {
            return {
                ...finding,
                verified: false,
                verificationNotes: `Function "${funcName}" only has ${func.paramCount} params`,
            };
        }
    }

    if (finding.category === 'complex_conditional') {
        if (func.maxNesting < 3) {
            return {
                ...finding,
                verified: false,
                verificationNotes: `Function "${funcName}" max nesting is only ${func.maxNesting}`,
            };
        }
    }

    return {
        ...finding,
        verified: true,
        verificationNotes: `Function "${funcName}" verified (${func.lineCount} lines, ${func.paramCount} params, nesting:${func.maxNesting})`,
    };
}

function verifyErrorHandlingFinding(finding: DeepFinding, facts: FileFacts): VerifiedFinding {
    if (finding.category === 'empty_catch') {
        if (facts.errorHandling.length === 0) {
            return { ...finding, verified: false, verificationNotes: 'No error handling found' };
        }
        const hasEmpty = facts.errorHandling.some(e => e.isEmpty);
        return {
            ...finding,
            verified: hasEmpty,
            verificationNotes: hasEmpty ? 'Empty catch blocks confirmed' : 'No empty catches found',
        };
    }

    if (finding.category === 'error_inconsistency') {
        const strategies = new Set(facts.errorHandling.map(e => e.strategy));
        return {
            ...finding,
            verified: strategies.size >= 2,
            verificationNotes: `${strategies.size} error strategies: ${[...strategies].join(', ')}`,
        };
    }

    // missing_error_check, error_swallowing, panic_in_library
    // These are harder to verify mechanically — accept on confidence + file existence
    return {
        ...finding,
        verified: finding.confidence >= 0.4,
        verificationNotes: 'Accepted on confidence',
    };
}

function verifyInterfaceFinding(finding: DeepFinding, facts: FileFacts): VerifiedFinding {
    const interfaces = facts.interfaces || [];
    if (interfaces.length === 0) {
        return { ...finding, verified: false, verificationNotes: 'No interfaces found' };
    }

    const ifaceName = extractEntityName(finding.description, interfaces.map(i => i.name));
    if (ifaceName) {
        const iface = interfaces.find(i => i.name === ifaceName);
        if (iface && iface.methodCount > 5) {
            return {
                ...finding,
                verified: true,
                verificationNotes: `Interface "${ifaceName}" has ${iface.methodCount} methods — ISP violation confirmed`,
            };
        }
    }

    return {
        ...finding,
        verified: finding.confidence >= 0.5,
        verificationNotes: 'Accepted on confidence',
    };
}

function verifyConcurrencyFinding(finding: DeepFinding, facts: FileFacts): VerifiedFinding {
    const hasConcurrency = (facts.goroutines || 0) > 0
        || (facts.channels || 0) > 0
        || (facts.mutexes || 0) > 0
        || facts.functions.some(f => f.isAsync);

    if (!hasConcurrency) {
        return {
            ...finding,
            verified: false,
            verificationNotes: 'No concurrency constructs found in file',
        };
    }

    // goroutine_leak: must have goroutines
    if (finding.category === 'goroutine_leak' && (facts.goroutines || 0) === 0) {
        return { ...finding, verified: false, verificationNotes: 'No goroutines found' };
    }

    // channel_misuse: must have channels
    if (finding.category === 'channel_misuse' && (facts.channels || 0) === 0) {
        return { ...finding, verified: false, verificationNotes: 'No channels found' };
    }

    // mutex_scope: must have mutexes
    if (finding.category === 'mutex_scope' && (facts.mutexes || 0) === 0) {
        return { ...finding, verified: false, verificationNotes: 'No mutex usage found' };
    }

    return {
        ...finding,
        verified: finding.confidence >= 0.4,
        verificationNotes: `Concurrency constructs present: goroutines:${facts.goroutines || 0}, channels:${facts.channels || 0}, mutexes:${facts.mutexes || 0}`,
    };
}

function verifyTestFinding(finding: DeepFinding, facts: FileFacts): VerifiedFinding {
    if (finding.category === 'missing_test') {
        // The finding says a file needs tests — verify the file is substantial enough
        return {
            ...finding,
            verified: !facts.hasTests && facts.lineCount > 50 && facts.functions.length > 1,
            verificationNotes: facts.hasTests
                ? 'File already has tests'
                : `File has ${facts.lineCount} lines, ${facts.functions.length} functions — needs tests`,
        };
    }

    if (finding.category === 'test_quality' && facts.hasTests) {
        return {
            ...finding,
            verified: finding.confidence >= 0.3,
            verificationNotes: `Test file with ${facts.testAssertions} assertions`,
        };
    }

    return {
        ...finding,
        verified: finding.confidence >= 0.3,
        verificationNotes: 'Accepted on confidence',
    };
}

/**
 * Try to find a known entity name referenced in a description string.
 */
function extractEntityName(description: string, knownNames: string[]): string | null {
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
 */
function findFile(filePath: string, factsByPath: Map<string, FileFacts>): FileFacts | null {
    if (factsByPath.has(filePath)) return factsByPath.get(filePath)!;

    const normalized = filePath.replace(/^\.\//, '');
    if (factsByPath.has(normalized)) return factsByPath.get(normalized)!;

    const parts = normalized.split('/');
    if (parts.length >= 2) {
        for (const [key, value] of factsByPath) {
            if (key.endsWith('/' + normalized) || key === normalized) {
                return value;
            }
        }
    } else {
        const fileName = parts[0];
        const matches: FileFacts[] = [];
        for (const [key, value] of factsByPath) {
            if (key.endsWith('/' + fileName) || key === fileName) {
                matches.push(value);
            }
        }
        if (matches.length === 1) return matches[0];
    }

    return null;
}
