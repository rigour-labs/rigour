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

        // ── Entity-name-verified categories (Tier 1) ──
        // LLM must reference a real class/struct/function name — drops hallucinated entities
        case 'lazy_class':
            return verifyLazyClass(finding, fileFacts);
        case 'feature_envy':
        case 'primitive_obsession':
        case 'speculative_generality':
        case 'refused_bequest':
        case 'missing_abstraction':
        case 'api_design':
            return verifyEntityNameRequired(finding, fileFacts);

        // ── Structural precondition categories (Tier 2) ──
        case 'dead_code':
            return verifyDeadCode(finding, fileFacts, factsByPath);
        case 'naming_convention':
            return verifyNamingConvention(finding, fileFacts);
        case 'hardcoded_config':
            return verifyHardcodedConfig(finding, fileFacts);
        case 'data_clump':
            return verifyDataClump(finding, fileFacts);
        case 'performance':
            return verifyPerformance(finding, fileFacts);

        // ── Cross-file graph categories (Tier 3) ──
        case 'circular_dependency':
            return verifyCircularDependency(finding, fileFacts, factsByPath);
        case 'dry_violation':
        case 'copy_paste_code':
            return verifyDryViolation(finding, fileFacts, factsByPath);
        case 'shotgun_surgery':
            return verifyShotgunSurgery(finding, fileFacts, factsByPath);
        case 'inappropriate_intimacy':
            return verifyInappropriateIntimacy(finding, fileFacts, factsByPath);

        // ── Confidence-floor categories (Tier 4) — raised from 0.3 → 0.5 ──
        case 'architecture':
        case 'package_cohesion':
        case 'code_smell':
        case 'language_idiom':
            return {
                ...finding,
                verified: finding.confidence >= 0.5,
                verificationNotes: finding.confidence < 0.5
                    ? `Low confidence (${finding.confidence}) — requires >= 0.5 for ${finding.category}`
                    : `Accepted at confidence ${finding.confidence} (threshold: 0.5)`,
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

// ════════════════════════════════════════════════════════════════════════
// Tier 1: Entity-name-verified categories
// LLM must reference a real class/struct/function — hallucinated names are dropped
// ════════════════════════════════════════════════════════════════════════

/**
 * Verify lazy_class: class/struct must exist AND have few methods.
 * A "lazy class" that doesn't exist is a hallucination.
 */
function verifyLazyClass(finding: DeepFinding, facts: FileFacts): VerifiedFinding {
    const entities = [
        ...facts.classes.map(c => ({ name: c.name, methodCount: c.methodCount, lineCount: c.lineCount })),
        ...(facts.structs || []).map(s => ({ name: s.name, methodCount: s.methodCount, lineCount: s.lineCount })),
    ];

    if (entities.length === 0) {
        return { ...finding, verified: false, verificationNotes: 'No classes or structs found — cannot verify lazy class' };
    }

    const entityName = extractEntityName(finding.description, entities.map(e => e.name));
    if (!entityName) {
        // LLM didn't reference a specific name — only accept if high confidence
        return {
            ...finding,
            verified: finding.confidence >= 0.6,
            verificationNotes: 'No entity name found in description — requires high confidence',
        };
    }

    const entity = entities.find(e => e.name === entityName);
    if (!entity) {
        return { ...finding, verified: false, verificationNotes: `Entity "${entityName}" not found in ${facts.path}` };
    }

    // Lazy class = too few methods for its existence
    if (entity.methodCount >= 4 && entity.lineCount >= 50) {
        return {
            ...finding,
            verified: false,
            verificationNotes: `"${entityName}" has ${entity.methodCount} methods, ${entity.lineCount} lines — not lazy`,
        };
    }

    return {
        ...finding,
        verified: true,
        verificationNotes: `"${entityName}" has only ${entity.methodCount} methods, ${entity.lineCount} lines — lazy class confirmed`,
    };
}

/**
 * Generic entity-name verification for design smell categories.
 * Requires the LLM to reference a real function/class/struct name.
 */
function verifyEntityNameRequired(finding: DeepFinding, facts: FileFacts): VerifiedFinding {
    const allNames = [
        ...facts.classes.map(c => c.name),
        ...(facts.structs || []).map(s => s.name),
        ...facts.functions.map(f => f.name),
    ];

    if (allNames.length === 0) {
        return { ...finding, verified: false, verificationNotes: 'No entities found in file' };
    }

    const entityName = extractEntityName(finding.description, allNames);
    if (entityName) {
        return {
            ...finding,
            verified: finding.confidence >= 0.3,
            verificationNotes: `Entity "${entityName}" exists — ${finding.category} accepted`,
        };
    }

    // LLM didn't name a specific entity — require higher confidence
    return {
        ...finding,
        verified: finding.confidence >= 0.6,
        verificationNotes: `No entity name matched in description — requires confidence >= 0.6 for ${finding.category}`,
    };
}

// ════════════════════════════════════════════════════════════════════════
// Tier 2: Structural precondition categories
// ════════════════════════════════════════════════════════════════════════

/**
 * Verify dead_code: function/export must exist AND not be referenced by other files.
 */
function verifyDeadCode(finding: DeepFinding, facts: FileFacts, factsByPath: Map<string, FileFacts>): VerifiedFinding {
    const allNames = [
        ...facts.functions.map(f => f.name),
        ...facts.exports,
        ...facts.classes.map(c => c.name),
    ];

    const entityName = extractEntityName(finding.description, allNames);
    if (!entityName) {
        return {
            ...finding,
            verified: finding.confidence >= 0.6,
            verificationNotes: 'No entity name found — requires high confidence for dead code',
        };
    }

    // Check if the entity is referenced in any other file's imports
    let referencedExternally = false;
    for (const [otherPath, otherFacts] of factsByPath) {
        if (otherPath === facts.path) continue;
        // Check if any import in other files references this entity or this file
        for (const imp of otherFacts.imports) {
            if (imp.includes(entityName)) {
                referencedExternally = true;
                break;
            }
        }
        if (referencedExternally) break;
    }

    if (referencedExternally) {
        return {
            ...finding,
            verified: false,
            verificationNotes: `"${entityName}" is imported by other files — not dead code`,
        };
    }

    // Check if the entity is exported (could be used externally)
    const func = facts.functions.find(f => f.name === entityName);
    if (func?.isExported) {
        // Exported but no internal references — might be a public API
        return {
            ...finding,
            verified: finding.confidence >= 0.5,
            verificationNotes: `"${entityName}" is exported but unreferenced — possible dead public API`,
        };
    }

    return {
        ...finding,
        verified: true,
        verificationNotes: `"${entityName}" exists and is not referenced externally — dead code confirmed`,
    };
}

/**
 * Verify naming_convention: check the referenced name against language-specific patterns.
 */
function verifyNamingConvention(finding: DeepFinding, facts: FileFacts): VerifiedFinding {
    const allNames = [
        ...facts.classes.map(c => c.name),
        ...(facts.structs || []).map(s => s.name),
        ...facts.functions.map(f => f.name),
    ];

    const entityName = extractEntityName(finding.description, allNames);
    if (!entityName) {
        return {
            ...finding,
            verified: finding.confidence >= 0.6,
            verificationNotes: 'No entity name found — requires high confidence for naming convention',
        };
    }

    // Language-specific naming convention checks
    let violatesConvention = false;
    let reason = '';

    switch (facts.language) {
        case 'go':
            // Go: exported = PascalCase, unexported = camelCase. Common violation: snake_case
            if (entityName.includes('_') && !entityName.startsWith('_') && entityName !== entityName.toUpperCase()) {
                violatesConvention = true;
                reason = 'Go names should use MixedCaps, not snake_case';
            }
            break;
        case 'python':
            // Python: functions/variables = snake_case, classes = PascalCase
            if (facts.functions.some(f => f.name === entityName)) {
                // Function — should be snake_case
                if (entityName !== entityName.toLowerCase() && /[A-Z]/.test(entityName) && !entityName.startsWith('_')) {
                    violatesConvention = true;
                    reason = 'Python functions should be snake_case';
                }
            } else if (facts.classes.some(c => c.name === entityName)) {
                // Class — should be PascalCase
                if (entityName.includes('_') && entityName !== entityName.toUpperCase()) {
                    violatesConvention = true;
                    reason = 'Python classes should be PascalCase';
                }
            }
            break;
        case 'typescript':
        case 'javascript':
            // JS/TS: functions = camelCase, classes = PascalCase
            if (facts.functions.some(f => f.name === entityName)) {
                if (entityName.includes('_') && entityName !== entityName.toUpperCase()) {
                    violatesConvention = true;
                    reason = 'JS/TS functions should be camelCase';
                }
            }
            break;
        default:
            // No language-specific check — fall back to confidence
            return {
                ...finding,
                verified: finding.confidence >= 0.5,
                verificationNotes: `No naming rules for ${facts.language} — accepted on confidence`,
            };
    }

    if (!violatesConvention) {
        return {
            ...finding,
            verified: false,
            verificationNotes: `"${entityName}" follows ${facts.language} naming conventions — false positive`,
        };
    }

    return {
        ...finding,
        verified: true,
        verificationNotes: `"${entityName}" — ${reason}`,
    };
}

/**
 * Verify hardcoded_config: file must have sufficient magic numbers or string constants.
 */
function verifyHardcodedConfig(finding: DeepFinding, facts: FileFacts): VerifiedFinding {
    const hasMagicNumbers = (facts.magicNumbers || 0) > 2;
    const isTestFile = facts.hasTests;

    // Don't flag test files for hardcoded config — test data is expected
    if (isTestFile) {
        return {
            ...finding,
            verified: false,
            verificationNotes: 'Test files are expected to have hardcoded values',
        };
    }

    if (hasMagicNumbers) {
        return {
            ...finding,
            verified: true,
            verificationNotes: `File has ${facts.magicNumbers} magic numbers — hardcoded config likely`,
        };
    }

    // No magic numbers detected by AST — require higher LLM confidence
    return {
        ...finding,
        verified: finding.confidence >= 0.6,
        verificationNotes: `No magic numbers detected by AST (${facts.magicNumbers || 0}) — requires confidence >= 0.6`,
    };
}

/**
 * Verify data_clump: multiple functions must share 3+ similar parameter names.
 */
function verifyDataClump(finding: DeepFinding, facts: FileFacts): VerifiedFinding {
    if (facts.functions.length < 2) {
        return { ...finding, verified: false, verificationNotes: 'Need multiple functions to detect data clump' };
    }

    // Check if any pair of functions shares 3+ parameter names
    let maxSharedParams = 0;
    let clumpPair = '';
    for (let i = 0; i < facts.functions.length; i++) {
        for (let j = i + 1; j < facts.functions.length; j++) {
            const paramsA = new Set(facts.functions[i].params.map(p => p.replace(/[:\s].*/, '').trim().toLowerCase()));
            const paramsB = new Set(facts.functions[j].params.map(p => p.replace(/[:\s].*/, '').trim().toLowerCase()));
            const shared = [...paramsA].filter(p => paramsB.has(p) && p.length > 1).length;
            if (shared > maxSharedParams) {
                maxSharedParams = shared;
                clumpPair = `${facts.functions[i].name} & ${facts.functions[j].name}`;
            }
        }
    }

    if (maxSharedParams >= 3) {
        return {
            ...finding,
            verified: true,
            verificationNotes: `${clumpPair} share ${maxSharedParams} parameters — data clump confirmed`,
        };
    }

    return {
        ...finding,
        verified: false,
        verificationNotes: `Max shared params between any function pair: ${maxSharedParams} (need >= 3)`,
    };
}

/**
 * Verify performance: function must be non-trivial (> 20 lines or has deep nesting).
 */
function verifyPerformance(finding: DeepFinding, facts: FileFacts): VerifiedFinding {
    const entityName = extractEntityName(finding.description, facts.functions.map(f => f.name));

    if (entityName) {
        const func = facts.functions.find(f => f.name === entityName);
        if (!func) {
            return { ...finding, verified: false, verificationNotes: `Function "${entityName}" not found` };
        }
        if (func.lineCount < 10) {
            return {
                ...finding,
                verified: false,
                verificationNotes: `Function "${entityName}" is only ${func.lineCount} lines — unlikely performance issue`,
            };
        }
        return {
            ...finding,
            verified: true,
            verificationNotes: `Function "${entityName}" is ${func.lineCount} lines — performance review accepted`,
        };
    }

    // No specific function referenced — check file-level
    if (facts.lineCount < 50) {
        return {
            ...finding,
            verified: false,
            verificationNotes: `File is only ${facts.lineCount} lines — unlikely performance hotspot`,
        };
    }

    return {
        ...finding,
        verified: finding.confidence >= 0.5,
        verificationNotes: `No specific function referenced — accepted at confidence >= 0.5`,
    };
}

// ════════════════════════════════════════════════════════════════════════
// Tier 3: Cross-file graph verification
// ════════════════════════════════════════════════════════════════════════

/**
 * Verify circular_dependency: build import graph and check if a cycle actually exists.
 */
function verifyCircularDependency(finding: DeepFinding, facts: FileFacts, factsByPath: Map<string, FileFacts>): VerifiedFinding {
    // Extract the other file(s) mentioned in the finding description
    const mentionedPaths: string[] = [];
    for (const [p] of factsByPath) {
        const baseName = p.split('/').pop() || '';
        const dirName = p.split('/').slice(-2).join('/');
        if (finding.description.includes(baseName) || finding.description.includes(dirName) || finding.description.includes(p)) {
            if (p !== facts.path) mentionedPaths.push(p);
        }
    }

    if (mentionedPaths.length === 0) {
        // LLM didn't reference a specific file — require high confidence
        return {
            ...finding,
            verified: finding.confidence >= 0.6,
            verificationNotes: 'No specific file path mentioned in description — requires confidence >= 0.6',
        };
    }

    // Check for actual bidirectional imports
    for (const otherPath of mentionedPaths) {
        const otherFacts = factsByPath.get(otherPath);
        if (!otherFacts) continue;

        const thisImportsOther = facts.imports.some(imp =>
            otherPath.includes(imp.replace(/\./g, '/')) || imp.includes(otherPath.replace(/\//g, '.').replace(/\.\w+$/, ''))
        );
        const otherImportsThis = otherFacts.imports.some(imp =>
            facts.path.includes(imp.replace(/\./g, '/')) || imp.includes(facts.path.replace(/\//g, '.').replace(/\.\w+$/, ''))
        );

        if (thisImportsOther && otherImportsThis) {
            return {
                ...finding,
                verified: true,
                verificationNotes: `Circular import confirmed: ${facts.path} ↔ ${otherPath}`,
            };
        }
    }

    // Check generic: does the current file import something that imports it back?
    const thisFileModules = new Set(facts.imports);
    for (const [otherPath, otherFacts] of factsByPath) {
        if (otherPath === facts.path) continue;
        const otherImportsThis = otherFacts.imports.some(imp => {
            const normalized = facts.path.replace(/\.\w+$/, '').replace(/\//g, '/');
            return normalized.endsWith(imp.replace(/\./g, '/')) || imp.endsWith(normalized);
        });
        if (otherImportsThis) {
            const thisImportsOther = facts.imports.some(imp => {
                const normalized = otherPath.replace(/\.\w+$/, '').replace(/\//g, '/');
                return normalized.endsWith(imp.replace(/\./g, '/')) || imp.endsWith(normalized);
            });
            if (thisImportsOther) {
                return {
                    ...finding,
                    verified: true,
                    verificationNotes: `Circular import found: ${facts.path} ↔ ${otherPath}`,
                };
            }
        }
    }

    return {
        ...finding,
        verified: false,
        verificationNotes: 'No circular dependency found in import graph',
    };
}

/**
 * Verify dry_violation / copy_paste_code: check for functions with similar signatures across files.
 */
function verifyDryViolation(finding: DeepFinding, facts: FileFacts, factsByPath: Map<string, FileFacts>): VerifiedFinding {
    // Extract referenced function name
    const entityName = extractEntityName(
        finding.description,
        facts.functions.map(f => f.name),
    );

    if (entityName) {
        const func = facts.functions.find(f => f.name === entityName);
        if (!func) {
            return { ...finding, verified: false, verificationNotes: `Function "${entityName}" not found` };
        }

        // Check if a similar function exists in another file
        for (const [otherPath, otherFacts] of factsByPath) {
            if (otherPath === facts.path) continue;
            for (const otherFunc of otherFacts.functions) {
                // Similar if: same name, or similar param count and line count
                const nameSimilar = otherFunc.name === func.name
                    || otherFunc.name.toLowerCase() === func.name.toLowerCase();
                const structSimilar = Math.abs(otherFunc.paramCount - func.paramCount) <= 1
                    && Math.abs(otherFunc.lineCount - func.lineCount) <= 5
                    && func.lineCount > 5;

                if (nameSimilar || structSimilar) {
                    return {
                        ...finding,
                        verified: true,
                        verificationNotes: `"${entityName}" (${func.lineCount} lines) similar to "${otherFunc.name}" in ${otherPath} (${otherFunc.lineCount} lines)`,
                    };
                }
            }
        }

        return {
            ...finding,
            verified: false,
            verificationNotes: `No similar function found across files for "${entityName}"`,
        };
    }

    // No function name — require high confidence
    return {
        ...finding,
        verified: finding.confidence >= 0.6,
        verificationNotes: 'No entity name found in DRY violation — requires confidence >= 0.6',
    };
}

/**
 * Verify shotgun_surgery: an entity should be referenced/imported by many files (>= 4).
 */
function verifyShotgunSurgery(finding: DeepFinding, facts: FileFacts, factsByPath: Map<string, FileFacts>): VerifiedFinding {
    const allNames = [
        ...facts.classes.map(c => c.name),
        ...(facts.structs || []).map(s => s.name),
        ...facts.functions.filter(f => f.isExported).map(f => f.name),
    ];

    const entityName = extractEntityName(finding.description, allNames);
    if (!entityName) {
        return {
            ...finding,
            verified: finding.confidence >= 0.6,
            verificationNotes: 'No entity name found — requires high confidence for shotgun surgery',
        };
    }

    // Count how many other files reference this entity
    let importerCount = 0;
    for (const [otherPath, otherFacts] of factsByPath) {
        if (otherPath === facts.path) continue;
        if (otherFacts.imports.some(imp => imp.includes(entityName))) {
            importerCount++;
        }
    }

    if (importerCount >= 4) {
        return {
            ...finding,
            verified: true,
            verificationNotes: `"${entityName}" is imported by ${importerCount} files — shotgun surgery confirmed`,
        };
    }

    return {
        ...finding,
        verified: false,
        verificationNotes: `"${entityName}" only imported by ${importerCount} files (need >= 4 for shotgun surgery)`,
    };
}

/**
 * Verify inappropriate_intimacy: two modules must have bidirectional imports.
 */
function verifyInappropriateIntimacy(finding: DeepFinding, facts: FileFacts, factsByPath: Map<string, FileFacts>): VerifiedFinding {
    // Look for bidirectional import relationships from this file
    let biDirectionalCount = 0;
    let biDirectionalPartner = '';

    for (const [otherPath, otherFacts] of factsByPath) {
        if (otherPath === facts.path) continue;

        const thisImportsOther = facts.imports.some(imp => {
            const otherModule = otherPath.replace(/\.\w+$/, '');
            return otherModule.endsWith(imp.replace(/\./g, '/')) || imp.endsWith(otherModule.split('/').pop() || '');
        });
        const otherImportsThis = otherFacts.imports.some(imp => {
            const thisModule = facts.path.replace(/\.\w+$/, '');
            return thisModule.endsWith(imp.replace(/\./g, '/')) || imp.endsWith(thisModule.split('/').pop() || '');
        });

        if (thisImportsOther && otherImportsThis) {
            biDirectionalCount++;
            biDirectionalPartner = otherPath;
        }
    }

    if (biDirectionalCount > 0) {
        return {
            ...finding,
            verified: true,
            verificationNotes: `Bidirectional import with ${biDirectionalPartner} — inappropriate intimacy confirmed`,
        };
    }

    return {
        ...finding,
        verified: false,
        verificationNotes: 'No bidirectional import relationships found',
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
