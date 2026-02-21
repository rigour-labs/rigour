/**
 * Prompt Engineering — Step 2 of the three-step pipeline.
 * Constructs structured prompts that ask the LLM to interpret AST-extracted facts.
 */
import type { FileFacts } from './fact-extractor.js';

/**
 * System prompt that defines the LLM's role and output format.
 */
export const DEEP_SYSTEM_PROMPT = `You are a senior code reviewer performing deep quality analysis. You receive AST-extracted facts about a codebase and must identify quality issues.

IMPORTANT RULES:
1. ONLY report issues you can verify from the provided facts. Do NOT hallucinate files, classes, or functions.
2. Every finding MUST reference a real file and entity from the facts.
3. Be specific: include file paths, class names, function names, line counts.
4. Assign confidence scores honestly: 0.9+ only for certain issues, 0.5-0.7 for probable issues.
5. Respond ONLY with valid JSON matching the schema below. No explanation text outside JSON.

OUTPUT SCHEMA:
{
  "findings": [
    {
      "category": "string (one of: srp_violation, ocp_violation, lsp_violation, isp_violation, dip_violation, dry_violation, god_class, god_function, feature_envy, shotgun_surgery, long_params, data_clump, inappropriate_intimacy, error_inconsistency, empty_catch, test_quality, code_smell, architecture, language_idiom)",
      "severity": "string (critical|high|medium|low|info)",
      "file": "string (exact file path from facts)",
      "line": "number or null",
      "description": "string (what the issue is, referencing specific entities)",
      "suggestion": "string (actionable fix recommendation)",
      "confidence": "number 0.0-1.0"
    }
  ]
}`;

/**
 * Build the analysis prompt for a batch of file facts.
 */
export function buildAnalysisPrompt(factsStr: string, checks?: Record<string, boolean>): string {
    const enabledChecks = checks ? Object.entries(checks)
        .filter(([, enabled]) => enabled)
        .map(([check]) => check)
        : ['solid', 'dry', 'design_patterns', 'language_idioms', 'error_handling', 'test_quality', 'architecture', 'code_smells'];

    const checkDescriptions: Record<string, string> = {
        solid: 'SOLID principle violations (SRP, OCP, LSP, ISP, DIP)',
        dry: 'DRY violations — duplicated logic across files',
        design_patterns: 'Design pattern issues: god class/function, feature envy, shotgun surgery, long parameter lists, data clumps, inappropriate intimacy',
        language_idioms: 'Language-specific anti-patterns and idiom violations',
        error_handling: 'Error handling strategy inconsistencies and empty catch blocks',
        test_quality: 'Test quality issues: insufficient assertions, missing edge case coverage, mock-heavy tests',
        architecture: 'Architecture-level concerns: layer violations, coupling, dependency flow',
        code_smells: 'General code smells with refactoring suggestions',
    };

    const checksStr = enabledChecks
        .map(c => `- ${checkDescriptions[c] || c}`)
        .join('\n');

    return `${DEEP_SYSTEM_PROMPT}

ANALYSIS FOCUS:
${checksStr}

AST-EXTRACTED FACTS:
${factsStr}

Analyze the codebase facts above. Identify all quality issues matching the analysis focus areas. Return findings as JSON.`;
}

/**
 * Build a cross-file analysis prompt that looks at patterns across the whole codebase.
 */
export function buildCrossFilePrompt(allFacts: FileFacts[]): string {
    // Build a high-level codebase summary
    const summary: string[] = [];

    // Error handling consistency
    const errorStrategies = new Map<string, Set<string>>();
    for (const f of allFacts) {
        for (const eh of f.errorHandling) {
            const strategies = errorStrategies.get(f.path) || new Set();
            strategies.add(eh.strategy);
            errorStrategies.set(f.path, strategies);
        }
    }

    const allStrategies = new Set<string>();
    for (const strats of errorStrategies.values()) {
        for (const s of strats) allStrategies.add(s);
    }
    if (allStrategies.size > 2) {
        summary.push(`ERROR HANDLING: ${allStrategies.size} different strategies used across codebase: ${[...allStrategies].join(', ')}`);
    }

    // Pattern consistency (naming)
    const classNames = allFacts.flatMap(f => f.classes.map(c => c.name));
    const suffixes = classNames.map(n => {
        const match = n.match(/(Service|Controller|Handler|Manager|Repository|Factory|Provider|Util|Helper)$/);
        return match?.[1];
    }).filter(Boolean);
    if (suffixes.length > 0) {
        const suffixCounts = new Map<string, number>();
        for (const s of suffixes) {
            suffixCounts.set(s!, (suffixCounts.get(s!) || 0) + 1);
        }
        summary.push(`NAMING PATTERNS: ${[...suffixCounts.entries()].map(([k, v]) => `${v}x ${k}`).join(', ')}`);
    }

    // Dependency flow
    const importMap = new Map<string, string[]>();
    for (const f of allFacts) {
        importMap.set(f.path, f.imports);
    }

    // Files with many dependents
    const dependentCounts = new Map<string, number>();
    for (const [file, imports] of importMap) {
        for (const imp of imports) {
            if (imp.startsWith('.')) {
                dependentCounts.set(imp, (dependentCounts.get(imp) || 0) + 1);
            }
        }
    }
    const highDependents = [...dependentCounts.entries()]
        .filter(([, count]) => count >= 5)
        .sort((a, b) => b[1] - a[1]);
    if (highDependents.length > 0) {
        summary.push(`HIGH-DEPENDENCY MODULES: ${highDependents.map(([m, c]) => `${m} (${c} dependents)`).join(', ')}`);
    }

    return `${DEEP_SYSTEM_PROMPT}

CROSS-FILE ANALYSIS REQUEST:
Look at the codebase-wide patterns and identify:
1. Inconsistent patterns across files (error handling, naming, structure)
2. Module coupling issues (high dependency counts)
3. Architecture-level concerns

CODEBASE SUMMARY:
${summary.join('\n')}

FILE COUNT: ${allFacts.length}
TOTAL CLASSES: ${allFacts.reduce((a, f) => a + f.classes.length, 0)}
TOTAL FUNCTIONS: ${allFacts.reduce((a, f) => a + f.functions.length, 0)}
TEST FILES: ${allFacts.filter(f => f.hasTests).length}

Return findings as JSON.`;
}

/**
 * Chunk file facts into batches that fit within token limits.
 * Groups related files (same directory) together.
 */
export function chunkFacts(facts: FileFacts[], maxCharsPerChunk = 3000): FileFacts[][] {
    // Group by directory
    const dirGroups = new Map<string, FileFacts[]>();
    for (const f of facts) {
        const dir = f.path.split('/').slice(0, -1).join('/') || '.';
        const group = dirGroups.get(dir) || [];
        group.push(f);
        dirGroups.set(dir, group);
    }

    const chunks: FileFacts[][] = [];
    let currentChunk: FileFacts[] = [];
    let currentSize = 0;

    for (const group of dirGroups.values()) {
        for (const f of group) {
            const factSize = estimateFactSize(f);
            if (currentSize + factSize > maxCharsPerChunk && currentChunk.length > 0) {
                chunks.push(currentChunk);
                currentChunk = [];
                currentSize = 0;
            }
            currentChunk.push(f);
            currentSize += factSize;
        }
    }

    if (currentChunk.length > 0) {
        chunks.push(currentChunk);
    }

    return chunks;
}

function estimateFactSize(f: FileFacts): number {
    let size = f.path.length + 50;
    size += f.classes.reduce((a, c) => a + c.name.length + c.methods.length * 20 + 50, 0);
    size += f.functions.reduce((a, fn) => a + fn.name.length + fn.params.length * 15 + 50, 0);
    size += f.imports.length * 30;
    size += f.errorHandling.length * 30;
    return size;
}
