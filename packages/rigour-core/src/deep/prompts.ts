/**
 * Prompt Engineering — Step 2 of the three-step pipeline.
 * Constructs structured prompts that ask the LLM to interpret AST-extracted facts.
 */
import type { FileFacts } from './fact-extractor.js';

/**
 * System prompt that defines the LLM's role and output format.
 */
export const DEEP_SYSTEM_PROMPT = `You are an expert code reviewer and software architect performing deep quality analysis. You receive AST-extracted facts about a codebase and must identify quality issues, anti-patterns, and best practice violations.

IMPORTANT RULES:
1. ONLY report issues you can verify from the provided facts. Do NOT hallucinate files, classes, or functions.
2. Every finding MUST reference a real file and entity from the facts.
3. Be specific: include file paths, struct/class names, function names, line counts.
4. Assign confidence scores honestly: 0.9+ only for certain issues, 0.5-0.7 for probable issues.
5. Respond ONLY with valid JSON matching the schema below. No explanation text outside JSON.
6. AIM for 5-15 findings per batch. Be thorough — report ALL issues you can identify, not just the most obvious ones.
7. For Go code: treat structs as classes, receiver methods as class methods. Check Go idioms specifically.

OUTPUT SCHEMA:
{
  "findings": [
    {
      "category": "string (see CATEGORIES below)",
      "severity": "string (critical|high|medium|low|info)",
      "file": "string (exact file path from facts)",
      "line": "number or null",
      "description": "string (what the issue is, referencing specific entities)",
      "suggestion": "string (actionable fix recommendation)",
      "confidence": "number 0.0-1.0"
    }
  ]
}

CATEGORIES:
  SOLID Principles:
    srp_violation - Single file/struct/class handles multiple unrelated responsibilities
    ocp_violation - Code requires modification (not extension) for new behavior
    lsp_violation - Subtypes break substitutability contracts
    isp_violation - Interface has too many methods forcing unnecessary implementations
    dip_violation - High-level modules depend directly on low-level implementations

  Design Patterns & Anti-patterns:
    god_class - Class/struct with too many fields, methods, or responsibilities (>8 methods or >300 lines)
    god_function - Function exceeding 50 lines or doing too many things
    feature_envy - Function/method uses another module's data more than its own
    shotgun_surgery - A single change requires modifying many files
    long_params - Function with 4+ parameters (use struct/options pattern)
    data_clump - Same group of fields/params repeated across multiple structs/functions
    inappropriate_intimacy - Two modules too tightly coupled, accessing each other's internals
    primitive_obsession - Using primitives instead of domain types (string for email, int for ID)
    lazy_class - Struct/class that does too little to justify its existence
    speculative_generality - Over-engineered abstractions not justified by current usage
    refused_bequest - Subtype/implementation ignores inherited behavior

  DRY & Duplication:
    dry_violation - Duplicated logic across files that should be extracted
    copy_paste_code - Nearly identical functions/methods in different files

  Error Handling:
    error_inconsistency - Mixed error handling strategies in same package/module
    empty_catch - Empty catch/except blocks that silently swallow errors
    error_swallowing - Errors logged but not propagated when they should be
    missing_error_check - Return values (especially errors) not checked
    panic_in_library - Library code using panic/os.Exit instead of returning errors

  Concurrency (Go/Rust/async languages):
    race_condition - Shared mutable state accessed without synchronization
    goroutine_leak - Goroutines spawned without cancellation/context mechanism
    missing_context - Functions that should accept context.Context but don't
    channel_misuse - Unbuffered channels that could deadlock, or missing close()
    mutex_scope - Mutex held too long or across I/O operations

  Testing:
    test_quality - Insufficient assertions, no edge cases, weak coverage
    test_coupling - Tests tightly coupled to implementation details
    missing_test - Complex public function/method with no corresponding test
    test_duplication - Multiple tests verifying the same behavior redundantly

  Architecture:
    architecture - Layer violations, wrong dependency direction
    circular_dependency - Modules that import each other
    package_cohesion - Package/directory contains unrelated concerns
    api_design - Exported API is confusing, inconsistent, or poorly structured
    missing_abstraction - Direct usage where an interface/abstraction would improve design

  Language Idioms:
    language_idiom - Language-specific anti-patterns
    naming_convention - Names don't follow language conventions (Go: MixedCaps, Python: snake_case)
    dead_code - Unreferenced exports, unused functions
    magic_number - Numeric literals without named constants

  Performance & Security:
    performance - Obvious performance anti-patterns (N+1 queries, unbounded allocations)
    resource_leak - Opened resources (files, connections, readers) not properly closed
    hardcoded_config - Configuration values hardcoded instead of externalized

  Code Smells:
    code_smell - General smell with refactoring suggestion
    complex_conditional - Deeply nested or overly complex conditional logic
    long_file - File exceeds reasonable length for its responsibility`;

/**
 * Language-specific analysis guidance appended to prompts.
 */
const LANGUAGE_GUIDANCE: Record<string, string> = {
    go: `
GO-SPECIFIC CHECKS (apply these strictly):
- Error handling: Every function returning error must be checked. Look for _ = fn() patterns.
- Context propagation: HTTP handlers and long-running ops should accept context.Context.
- Interface design: Go interfaces should be small (1-3 methods). Large interfaces violate ISP.
- Goroutine safety: Goroutines without context/done channels are potential leaks.
- Defer usage: Missing defer for Close/Unlock calls → resource leaks.
- Struct design: Structs with >8 fields may need decomposition.
- Receiver consistency: All methods on a type should use pointer OR value receiver, not mixed.
- Package naming: Should be short, lowercase, no underscores.
- Error wrapping: Errors should be wrapped with %w for context, not just fmt.Errorf.
- Init functions: Avoid init() — makes testing hard and creates hidden dependencies.
- Global state: Package-level mutable variables are a code smell.`,

    typescript: `
TYPESCRIPT-SPECIFIC CHECKS:
- Use strict null checks. Watch for missing null/undefined guards.
- Prefer interfaces over type aliases for object shapes.
- Avoid 'any' type — use 'unknown' with type guards.
- Async functions should have proper error boundaries.
- Watch for promise chains without .catch() or try/catch.
- Large barrel files (index.ts re-exporting everything) hurt tree-shaking.
- Avoid enums — use 'as const' objects or union types.`,

    javascript: `
JAVASCRIPT-SPECIFIC CHECKS:
- Missing null/undefined checks on function parameters.
- Callback hell — should use async/await.
- var usage — should use const/let.
- == instead of === (loose equality).
- Prototype pollution risks in object manipulation.`,

    python: `
PYTHON-SPECIFIC CHECKS:
- Missing type hints on public functions.
- Bare except clauses that catch all exceptions.
- Mutable default arguments (def fn(x=[])).
- Not using context managers (with statement) for resources.
- Import * polluting namespace.
- Missing __init__.py or improper package structure.`,

    rust: `
RUST-SPECIFIC CHECKS:
- Unwrap/expect in library code instead of proper error handling (?).
- Clone where borrow would suffice.
- Large enums that should be split.
- Missing Send/Sync bounds on async code.
- Unsafe blocks without safety documentation.`,

    java: `
JAVA-SPECIFIC CHECKS:
- God classes with too many responsibilities.
- Missing @Override annotations.
- Raw types instead of generics.
- Checked exceptions caught and ignored.
- Static utility classes that should be injected services.`,

    csharp: `
C#-SPECIFIC CHECKS:
- Not using 'using' for IDisposable resources.
- Async void methods (should be async Task).
- Missing null checks (use nullable reference types).
- Large switch statements that should use polymorphism.`,
};

/**
 * Build the analysis prompt for a batch of file facts.
 */
export function buildAnalysisPrompt(factsStr: string, checks?: Record<string, boolean>): string {
    const enabledChecks = checks ? Object.entries(checks)
        .filter(([, enabled]) => enabled)
        .map(([check]) => check)
        : ['solid', 'dry', 'design_patterns', 'language_idioms', 'error_handling',
           'test_quality', 'architecture', 'code_smells', 'concurrency',
           'performance', 'naming', 'resource_management'];

    const checkDescriptions: Record<string, string> = {
        solid: 'SOLID principle violations (SRP, OCP, LSP, ISP, DIP)',
        dry: 'DRY violations — duplicated logic, copy-paste code across files',
        design_patterns: 'Design pattern anti-patterns: god class/struct, god function, feature envy, shotgun surgery, long parameter lists, data clumps, inappropriate intimacy, primitive obsession, lazy class, speculative generality',
        language_idioms: 'Language-specific anti-patterns, naming convention violations, dead code',
        error_handling: 'Error handling: inconsistencies, empty catches, swallowed errors, missing error checks, panic in library code',
        test_quality: 'Test quality: insufficient assertions, missing edge cases, test coupling, missing tests for complex code',
        architecture: 'Architecture: layer violations, circular dependencies, package cohesion, API design, missing abstractions',
        code_smells: 'Code smells: complex conditionals, magic numbers, long files, hardcoded config',
        concurrency: 'Concurrency: race conditions, goroutine leaks, missing context, channel misuse, mutex scope',
        performance: 'Performance anti-patterns: resource leaks, unbounded allocations, N+1 patterns',
        naming: 'Naming conventions: language-appropriate naming, unclear/misleading names',
        resource_management: 'Resource management: unclosed files/connections, missing defer/cleanup',
    };

    const checksStr = enabledChecks
        .map(c => `- ${checkDescriptions[c] || c}`)
        .join('\n');

    // Detect dominant language from facts
    const langCounts = new Map<string, number>();
    const langPattern = /\((\w+),/g;
    let langMatch;
    while ((langMatch = langPattern.exec(factsStr)) !== null) {
        const lang = langMatch[1];
        langCounts.set(lang, (langCounts.get(lang) || 0) + 1);
    }
    let dominantLang = '';
    let maxCount = 0;
    for (const [lang, count] of langCounts) {
        if (count > maxCount) { maxCount = count; dominantLang = lang; }
    }

    const langGuide = LANGUAGE_GUIDANCE[dominantLang] || '';

    return `${DEEP_SYSTEM_PROMPT}

ANALYSIS FOCUS:
${checksStr}
${langGuide}

AST-EXTRACTED FACTS:
${factsStr}

Analyze the codebase facts above. Identify ALL quality issues matching the analysis focus areas. Be thorough — check every file for every category. Return findings as JSON.`;
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
    const classNames = allFacts.flatMap(f => [
        ...f.classes.map(c => c.name),
        ...(f.structs || []).map(s => s.name),
    ]);
    const suffixes = classNames.map(n => {
        const match = n.match(/(Service|Controller|Handler|Manager|Repository|Factory|Provider|Util|Helper|Store|Client|Config|Options|Middleware|Router|Server)$/);
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
            if (imp.startsWith('.') || imp.startsWith('./') || imp.startsWith('../')) {
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

    // Package/directory structure
    const dirCounts = new Map<string, number>();
    for (const f of allFacts) {
        const dir = f.path.split('/').slice(0, -1).join('/') || '.';
        dirCounts.set(dir, (dirCounts.get(dir) || 0) + 1);
    }
    const largeDirs = [...dirCounts.entries()]
        .filter(([, count]) => count >= 10)
        .sort((a, b) => b[1] - a[1]);
    if (largeDirs.length > 0) {
        summary.push(`LARGE PACKAGES: ${largeDirs.map(([d, c]) => `${d}/ (${c} files)`).join(', ')}`);
    }

    // Test coverage gaps
    const untestedFiles = allFacts.filter(f => !f.hasTests && f.lineCount > 100 && f.functions.length > 2);
    if (untestedFiles.length > 0) {
        summary.push(`UNTESTED COMPLEX FILES: ${untestedFiles.slice(0, 10).map(f => `${f.path} (${f.lineCount}L, ${f.functions.length} fns)`).join(', ')}`);
    }

    // Concurrency summary (Go)
    const concurrentFiles = allFacts.filter(f => (f.goroutines || 0) > 0 || (f.channels || 0) > 0);
    if (concurrentFiles.length > 0) {
        summary.push(`CONCURRENT FILES: ${concurrentFiles.map(f => `${f.path} (${f.goroutines || 0} goroutines, ${f.channels || 0} channels)`).join(', ')}`);
    }

    // Detect dominant language
    const langs = new Map<string, number>();
    for (const f of allFacts) {
        langs.set(f.language, (langs.get(f.language) || 0) + 1);
    }
    let dominantLang = '';
    let maxCount = 0;
    for (const [lang, count] of langs) {
        if (count > maxCount) { maxCount = count; dominantLang = lang; }
    }
    const langGuide = LANGUAGE_GUIDANCE[dominantLang] || '';

    return `${DEEP_SYSTEM_PROMPT}

CROSS-FILE ANALYSIS REQUEST:
Look at the codebase-wide patterns and identify:
1. Inconsistent patterns across files (error handling, naming, structure)
2. Module coupling issues (high dependency counts, circular deps)
3. Architecture-level concerns (package cohesion, layer violations)
4. Missing abstractions (repeated patterns that should be unified)
5. Test coverage gaps (complex code without tests)
6. Concurrency safety issues across the codebase
${langGuide}

CODEBASE SUMMARY:
${summary.join('\n')}

FILE COUNT: ${allFacts.length}
TOTAL STRUCTS/CLASSES: ${allFacts.reduce((a, f) => a + f.classes.length + (f.structs?.length || 0), 0)}
TOTAL FUNCTIONS: ${allFacts.reduce((a, f) => a + f.functions.length, 0)}
TOTAL INTERFACES: ${allFacts.reduce((a, f) => a + (f.interfaces?.length || 0), 0)}
TEST FILES: ${allFacts.filter(f => f.hasTests).length}

Return findings as JSON. Aim for 5-15 cross-cutting findings.`;
}

/**
 * Chunk file facts into batches that fit within token limits.
 * Groups related files (same directory) together.
 */
export function chunkFacts(facts: FileFacts[], maxCharsPerChunk = 6000): FileFacts[][] {
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
    size += (f.structs || []).reduce((a, s) => a + s.name.length + s.methods.length * 20 + s.embeds.length * 15 + 60, 0);
    size += (f.interfaces || []).reduce((a, i) => a + i.name.length + i.methods.length * 15 + 40, 0);
    size += f.functions.reduce((a, fn) => a + fn.name.length + fn.params.length * 15 + 50, 0);
    size += f.imports.length * 30;
    size += f.errorHandling.length * 30;
    return size;
}
