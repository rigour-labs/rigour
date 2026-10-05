import { z } from 'zod';

export const GatesSchema = z.object({
    max_file_lines: z.number().optional().default(500),
    forbid_todos: z.boolean().optional().default(true),
    forbid_fixme: z.boolean().optional().default(true),
    forbid_paths: z.array(z.string()).optional().default([]),
    required_files: z.array(z.string()).optional().default([
        'docs/SPEC.md',
        'docs/ARCH.md',
        'docs/DECISIONS.md',
        'docs/TASKS.md',
    ]),
    ast: z.object({
        complexity: z.number().optional().default(10),
        max_methods: z.number().optional().default(10),
        max_params: z.number().optional().default(5),
        max_nesting: z.number().optional().default(4),
        max_inheritance_depth: z.number().optional().default(3),
        max_class_dependencies: z.number().optional().default(5),
        max_function_lines: z.number().optional().default(50),
    }).optional().default({}),
    staleness: z.object({
        enabled: z.boolean().optional().default(false),
        // Rule-based staleness detection (toggle individual rules)
        rules: z.record(z.boolean()).optional().default({
            'no-var': true,              // var → const/let (ES6+)
            'no-commonjs': false,        // require() → import
            'no-arguments': false,       // arguments → rest params
            'prefer-arrow': false,       // function → arrow function
            'prefer-template': false,    // 'a' + b → `a${b}`
            'prefer-spread': false,      // apply() → spread
            'prefer-rest': false,        // arguments → ...args
            'prefer-const': false,       // let (unchanged) → const
        }),
    }).optional().default({}),
    dependencies: z.object({
        forbid: z.array(z.string()).optional().default([]),
        trusted_registry: z.string().optional(),
        detect_unused: z.boolean().optional().default(true),
        detect_heavy_alternatives: z.boolean().optional().default(true),
        detect_duplicate_purpose: z.boolean().optional().default(true),
        unused_allowlist: z.array(z.string()).optional().default([]),
    }).optional().default({}),
    architecture: z.object({
        boundaries: z.array(z.object({
            from: z.string(),
            to: z.string(),
            mode: z.enum(['allow', 'deny']).default('deny'),
        })).optional().default([]),
    }).optional().default({}),
    safety: z.object({
        max_files_changed_per_cycle: z.number().optional().default(10),
        protected_paths: z.array(z.string()).optional().default(['.github/**', 'docs/**', 'rigour.yml']),
    }).optional().default({}),
    context: z.object({
        enabled: z.boolean().optional().default(true),
        sensitivity: z.number().min(0).max(1).optional().default(0.8), // 0.8 correlation threshold
        mining_depth: z.number().optional().default(100), // Number of files to sample
        ignored_patterns: z.array(z.string()).optional().default([]),
        // v2.14+ Extended Context for frontier models
        cross_file_patterns: z.boolean().optional().default(true),
        naming_consistency: z.boolean().optional().default(true),
        import_relationships: z.boolean().optional().default(true),
        max_cross_file_depth: z.number().optional().default(50),
    }).optional().default({}),
    environment: z.object({
        enabled: z.boolean().optional().default(true),
        enforce_contracts: z.boolean().optional().default(true), // Auto-discovery of versions from truth sources
        tools: z.record(z.string()).optional().default({}), // Explicit overrides
        required_env: z.array(z.string()).optional().default([]),
    }).optional().default({}),
    retry_loop_breaker: z.object({
        enabled: z.boolean().optional().default(true),
        max_retries: z.number().optional().default(3), // Fail after 3 consecutive failures in same category
        auto_classify: z.boolean().optional().default(true), // Auto-detect failure category from error message
        doc_sources: z.record(z.string()).optional().default({}), // Custom doc URLs per category
    }).optional().default({}),
    agent_team: z.object({
        enabled: z.boolean().optional().default(false),
        max_concurrent_agents: z.number().optional().default(3),
        cross_agent_pattern_check: z.boolean().optional().default(true),
        handoff_verification: z.boolean().optional().default(true),
        task_ownership: z.enum(['strict', 'collaborative']).optional().default('strict'),
    }).optional().default({}),
    checkpoint: z.object({
        enabled: z.boolean().optional().default(false),
        interval_minutes: z.number().optional().default(15),
        quality_threshold: z.number().optional().default(80),
        drift_detection: z.boolean().optional().default(true),
        auto_save_on_failure: z.boolean().optional().default(true),
    }).optional().default({}),
    security: z.object({
        enabled: z.boolean().optional().default(true),
        sql_injection: z.boolean().optional().default(true),
        xss: z.boolean().optional().default(true),
        path_traversal: z.boolean().optional().default(true),
        hardcoded_secrets: z.boolean().optional().default(true),
        insecure_randomness: z.boolean().optional().default(true),
        command_injection: z.boolean().optional().default(true),
        block_on_severity: z.enum(['critical', 'high', 'medium', 'low']).optional().default('high'),
    }).optional().default({}),
    frontend_secret_exposure: z.object({
        enabled: z.boolean().optional().default(true),
        block_on_severity: z.enum(['critical', 'high', 'medium', 'low']).optional().default('high'),
        check_process_env: z.boolean().optional().default(true),
        check_import_meta_env: z.boolean().optional().default(true),
        secret_env_name_patterns: z.array(z.string()).optional().default([
            '(?:^|_)(?:secret|private)(?:_|$)',
            '(?:^|_)(?:token|api[_-]?key|access[_-]?key|client[_-]?secret|signing|webhook)(?:_|$)',
            '(?:^|_)(?:db[_-]?url|database[_-]?url|connection[_-]?string)(?:_|$)',
        ]),
        safe_public_prefixes: z.array(z.string()).optional().default([
            'NEXT_PUBLIC_',
            'VITE_',
            'PUBLIC_',
            'NUXT_PUBLIC_',
            'REACT_APP_',
        ]),
        frontend_path_patterns: z.array(z.string()).optional().default([
            '(^|/)pages/(?!api/)',
            '(^|/)components/',
            '(^|/)src/components/',
            '(^|/)src/views/',
            '(^|/)src/app/',
            '(^|/)app/(?!api/)',
            '(^|/)views/',
            '(^|/)public/',
        ]),
        server_path_patterns: z.array(z.string()).optional().default([
            '(^|/)pages/api/',
            '(^|/)src/pages/api/',
            '(^|/)app/api/',
            '(^|/)src/app/api/',
            '\\.server\\.(?:ts|tsx|js|jsx|mjs|cjs)$',
        ]),
        allowlist_env_names: z.array(z.string()).optional().default([]),
    }).optional().default({}),
    adaptive: z.object({
        enabled: z.boolean().optional().default(false),
        base_coverage_threshold: z.number().optional().default(80),
        base_quality_threshold: z.number().optional().default(80),
        auto_detect_tier: z.boolean().optional().default(true),
        forced_tier: z.enum(['hobby', 'startup', 'enterprise']).optional(),
    }).optional().default({}),
    // v2.16+ AI-Native Drift Detection Gates
    duplication_drift: z.object({
        enabled: z.boolean().optional().default(true),
        similarity_threshold: z.number().min(0).max(1).optional().default(0.8),
        min_body_lines: z.number().optional().default(5),
    }).optional().default({}),
    hallucinated_imports: z.object({
        enabled: z.boolean().optional().default(true),
        check_relative: z.boolean().optional().default(true),
        check_packages: z.boolean().optional().default(true),
        ignore_patterns: z.array(z.string()).optional().default([
            '\\.css$', '\\.scss$', '\\.less$', '\\.svg$', '\\.png$', '\\.jpg$',
            '\\.json$', '\\.wasm$', '\\.graphql$', '\\.gql$',
        ]),
    }).optional().default({}),
    inconsistent_error_handling: z.object({
        enabled: z.boolean().optional().default(true),
        max_strategies_per_type: z.number().optional().default(2),
        min_occurrences: z.number().optional().default(3),
        ignore_empty_catches: z.boolean().optional().default(false),
    }).optional().default({}),
    context_window_artifacts: z.object({
        enabled: z.boolean().optional().default(true),
        min_file_lines: z.number().optional().default(180),
        degradation_threshold: z.number().min(0).max(1).optional().default(0.55),
        signals_required: z.number().optional().default(4),
    }).optional().default({}),
    promise_safety: z.object({
        enabled: z.boolean().optional().default(true),
        check_unhandled_then: z.boolean().optional().default(true),
        check_unsafe_parse: z.boolean().optional().default(false), // opt-in: a regex cannot tell trusted JSON (own files, own serializer) from untrusted input
        check_async_without_await: z.boolean().optional().default(true),
        check_unsafe_fetch: z.boolean().optional().default(true),
        ignore_patterns: z.array(z.string()).optional().default([]),
    }).optional().default({}),
    // v3.1+ Extended Hallucination Detection
    phantom_apis: z.object({
        enabled: z.boolean().optional().default(true),
        check_node: z.boolean().optional().default(true),
        check_python: z.boolean().optional().default(true),
        check_go: z.boolean().optional().default(true),
        check_csharp: z.boolean().optional().default(true),
        check_java: z.boolean().optional().default(true),
        ignore_patterns: z.array(z.string()).optional().default([]),
    }).optional().default({}),
    deprecated_apis: z.object({
        enabled: z.boolean().optional().default(true),
        check_node: z.boolean().optional().default(true),
        check_python: z.boolean().optional().default(true),
        check_web: z.boolean().optional().default(true),
        check_go: z.boolean().optional().default(true),
        check_csharp: z.boolean().optional().default(true),
        check_java: z.boolean().optional().default(true),
        block_security_deprecated: z.boolean().optional().default(true),
        ignore_patterns: z.array(z.string()).optional().default([]),
    }).optional().default({}),
    test_quality: z.object({
        enabled: z.boolean().optional().default(true),
        check_empty_tests: z.boolean().optional().default(true),
        check_tautological: z.boolean().optional().default(true),
        check_mock_heavy: z.boolean().optional().default(true),
        check_snapshot_abuse: z.boolean().optional().default(true),
        check_assertion_free_async: z.boolean().optional().default(true),
        max_mocks_per_test: z.number().optional().default(5),
        ignore_patterns: z.array(z.string()).optional().default([]),
    }).optional().default({}),
    // v4.2+ Memory & Skills Governance
    governance: z.object({
        enabled: z.boolean().optional().default(true),
        /**
         * Block agent writes to native memory files (CLAUDE.md, …) and point to rigour_remember.
         * Off by default: teams edit their agent instructions deliberately; their content is still scanned for secrets.
         */
        enforce_memory: z.boolean().optional().default(false),
        /** Block agent writes to native skills/rules files (.cursor/rules, …). Off by default, like enforce_memory. */
        enforce_skills: z.boolean().optional().default(false),
        /** Block writes and tell agent to use rigour_remember / rigour_recall */
        block_native_memory: z.boolean().optional().default(true),
        /** Agent-native MEMORY paths — where agents auto-save context (glob patterns) */
        protected_memory_paths: z.array(z.string()).optional().default([
            // Claude Code — auto-memory
            'CLAUDE.md',
            '.claude/CLAUDE.md',
            // Cline — editable rules (agent can write)
            '.clinerules',
            '.clinerules/**',
            // Windsurf — auto-generated memories
            '.windsurf/memories/**',
            // Generic
            '.github/copilot-instructions.md',
        ]),
        /** Agent-native SKILLS/RULES paths — where agents store instructions/skills */
        protected_skills_paths: z.array(z.string()).optional().default([
            // Claude Code — skills, rules, commands
            '.claude/skills/**',
            '.claude/rules/**',
            '.claude/commands/**',
            // Cursor — rules and prompts
            '.cursorrules',
            '.cursor/rules/**',
            '.cursor/prompts/**',
            // Cline — rules directory
            '.cline/rules/**',
            // Windsurf — rules
            '.windsurf/rules/**',
            '.windsurfrules',
            // Copilot — instructions
            '.github/instructions/**',
            'copilot-instructions.md',
        ]),
        /** Paths that are exempt from governance (e.g. Rigour's own hook configs) */
        exempt_paths: z.array(z.string()).optional().default([
            '.claude/settings.json',   // Rigour's own hook config
            '.cursor/hooks.json',      // Rigour's own hook config
            '.windsurf/hooks.json',    // Rigour's own hook config
        ]),
    }).optional().default({}),
    // v4.2+ AI Agent DLP (Data Loss Prevention)
    input_validation: z.object({
        enabled: z.boolean().optional().default(true),
        block_on_detection: z.boolean().optional().default(true),
        min_secret_length: z.number().optional().default(8),
        custom_patterns: z.array(z.string()).optional().default([]),
        ignore_patterns: z.array(z.string()).optional().default([]),
        audit_log: z.boolean().optional().default(true),
    }).optional().default({}),
    // v4.3+ Side-Effect Safety Analysis
    // On by default: full scans of three real repositories reported no finding that was not a real defect.
    // A supabase-js read no index can serve, proved from the repository's own migrations (advisory, off by default).
    unindexed_reads: z.object({
        enabled: z.boolean().optional().default(false),
        migrations: z.array(z.string()).optional().default([]),
    }).optional().default({}),
    // A dependency whose installed version npm marks deprecated (advisory, off by default: it asks the registry).
    deprecated_dependencies: z.object({
        enabled: z.boolean().optional().default(false),
        registry: z.string().optional(),
    }).optional().default({}),
    // A migration added on a branch that sorts before the newest one on the base (advisory, off by default).
    /** Exports the change adds that no other file names (review/unused-exports.ts). */
    unused_exports: z.object({
        enabled: z.boolean().optional().default(true),
        allow: z.array(z.string()).optional().default([]), // export names a tool loads by name
    }).optional().default({}),
    /** Code files the change adds that nothing imports or runs (review/orphan-files.ts). */
    orphan_files: z.object({
        enabled: z.boolean().optional().default(true),
        allow: z.array(z.string()).optional().default([]), // globs for files a tool loads by path
    }).optional().default({}),
    migration_order: z.object({
        enabled: z.boolean().optional().default(false),
        dirs: z.array(z.string()).optional().default(['**/supabase/migrations']),
    }).optional().default({}),
    semantic_bugs: z.object({
        enabled: z.boolean().optional().default(true),
        rules: z.array(z.string()).optional(),
    }).optional().default({}),
    side_effect_analysis: z.object({
        enabled: z.boolean().optional().default(true),
        check_unbounded_timers: z.boolean().optional().default(true),
        check_unbounded_loops: z.boolean().optional().default(true),
        check_process_lifecycle: z.boolean().optional().default(true),
        check_recursive_depth: z.boolean().optional().default(true),
        check_resource_lifecycle: z.boolean().optional().default(true),
        check_retry_without_limit: z.boolean().optional().default(true),
        check_circular_triggers: z.boolean().optional().default(true),
        check_auto_restart: z.boolean().optional().default(true),
        ignore_patterns: z.array(z.string()).optional().default([]),
    }).optional().default({}),
    // v5.1+ Style Drift Detection
    style_drift: z.object({
        enabled: z.boolean().optional().default(true),
        deviation_threshold: z.number().min(0).max(1).optional().default(0.25),
        sample_size: z.number().optional().default(100),
        baseline_path: z.string().optional().default('.rigour/style-baseline.json'),
    }).optional().default({}),
    // v5.1+ Logic Drift Foundation
    logic_drift: z.object({
        enabled: z.boolean().optional().default(true),
        baseline_path: z.string().optional().default('.rigour/logic-baseline.json'),
        track_operators: z.boolean().optional().default(true),
        track_branches: z.boolean().optional().default(false), // opt-in: counts change on purpose in most edits
        track_returns: z.boolean().optional().default(false),  // opt-in: same
    }).optional().default({}),
    // v4.0+ Deep Analysis (LLM-powered)
    deep: z.object({
        enabled: z.boolean().optional().default(false),
        pro: z.boolean().optional().default(false),
        max: z.boolean().optional().default(false), // local Qwen2.5-Coder-7B (4.7GB); needs ~8GB free memory
        provider: z.string().optional().default('local'), // 'local' for sidecar, or any cloud: 'claude', 'openai', 'gemini', 'groq', 'mistral', 'together', etc.
        api_key: z.string().optional(),
        api_base_url: z.string().optional(), // custom API base URL (for self-hosted, proxies, any OpenAI-compatible endpoint)
        model_name: z.string().optional(), // cloud model name override (e.g. 'gpt-4o', 'claude-sonnet-4-5-20250929', 'gemini-pro')
        model_path: z.string().optional(), // custom local GGUF model path override
        threads: z.number().optional().default(4),
        max_tokens: z.number().optional(), // default per provider: local 1024, cloud 4096
        temperature: z.number().optional().default(0.1),
        timeout_ms: z.number().optional(), // per inference call; default per provider: local 60s, cloud 120s
        budget_ms: z.number().optional(), // whole deep run; files not started in time are reported as skipped
        agentic: z.boolean().optional(), // cloud tier: the model may read the repository while it reviews (default true)
        repo_rules: z.boolean().optional(), // show the reviewer the rules in AGENTS.md / CLAUDE.md / Cursor rules that name what the change touches (default false)
        review_lessons: z.enum(['verified', 'all', 'off']).optional(), // the team's past review lessons: they raise a function's risk and are shown to the reviewer. verified (default), all, or off
        router: z.object({ // cloud tier: review only the riskiest changed functions (deep/risk.ts)
            enabled: z.boolean().optional(), // default true
            min_score: z.number().optional(), // functions below this get the deterministic gates only
            max_functions: z.number().optional(), // at most this many functions go to the model
        }).optional(),
        // Intent questions at engine-proven sites (optional-read-no-fallback) in scoped reviews.
        // Off: the stock local models failed the zero-false-finding bar (docs/DEEP_ANALYSIS.md).
        intent_checks: z.boolean().optional().default(false),
        checks: z.object({
            solid: z.boolean().optional().default(true),
            dry: z.boolean().optional().default(true),
            design_patterns: z.boolean().optional().default(true),
            language_idioms: z.boolean().optional().default(true),
            error_handling: z.boolean().optional().default(true),
            test_quality: z.boolean().optional().default(true),
            architecture: z.boolean().optional().default(true),
            code_smells: z.boolean().optional().default(true),
        }).optional().default({}),
    }).optional().default({}),
});

export const CommandsSchema = z.object({
    format: z.string().optional(),
    lint: z.string().optional(),
    typecheck: z.string().optional(),
    test: z.string().optional(),
});

export const HooksSchema = z.object({
    enabled: z.boolean().optional().default(false),
    tools: z.array(z.enum(['claude', 'cursor', 'cline', 'windsurf'])).optional().default([]),
    fast_gates: z.array(z.string()).optional().default([
        'hallucinated-imports',
        'phantom-apis',
        'deprecated-apis',
        'promise-safety',
        'security-patterns',
        'side-effect-analysis',
        'file-size',
    ]),
    timeout_ms: z.number().optional().default(5000),
    block_on_failure: z.boolean().optional().default(false),
    /** Stop hook: hold "done" until the agent acknowledges each risky changed function (rigour_review_ack). */
    require_review_ack: z.boolean().optional().default(false),
    /** Enable DLP (Data Loss Prevention) pre-input hooks — default ON for security */
    dlp: z.boolean().optional().default(true),
}).optional().default({});

export const ConfigSchema = z.object({
    version: z.number().default(1),
    preset: z.string().optional(),
    paradigm: z.string().optional(),
    commands: CommandsSchema.optional().default({}),
    gates: GatesSchema.optional().default({}),
    hooks: HooksSchema,
    output: z.object({
        report_path: z.string().default('rigour-report.json'),
    }).optional().default({}),
    /** rigour review / rigour_review / the PR bot / the stop hook. */
    review: z.object({
        /** Let heuristic gates decide the verdict too; by default only findings that prove a defect do (quiet.ts). */
        include_heuristics: z.boolean().optional().default(false),
        /** Also report findings the base already had; by default only what the change introduced is (baseline.ts). */
        show_preexisting: z.boolean().optional().default(false),
        /** The GitHub account whose token fetches the pull request's previous review (`gh auth token --user`). */
        github_account: z.string().optional(),
        /** The fresh reviewer run before a push (review/reviewer.ts): the person's own coding agent CLI, headless. */
        reviewer: z.object({
            enabled: z.boolean().optional().default(true),
            command: z.string().optional().default('claude'),
            model: z.string().optional(),
            timeout_ms: z.number().optional().default(15 * 60_000),
        }).optional().default({}),
    }).optional().default({}),
    planned: z.array(z.string()).optional().default([]),
    ignore: z.array(z.string()).optional().default([]),
});

export type Gates = z.infer<typeof GatesSchema>;
export type Commands = z.infer<typeof CommandsSchema>;
export type Hooks = z.infer<typeof HooksSchema>;
export type Config = z.infer<typeof ConfigSchema>;

export type RawGates = z.input<typeof GatesSchema>;
export type RawCommands = z.input<typeof CommandsSchema>;
export type RawHooks = z.input<typeof HooksSchema>;
export type RawConfig = z.input<typeof ConfigSchema>;

export const StatusSchema = z.enum(['PASS', 'FAIL', 'SKIP', 'ERROR']);
export type Status = z.infer<typeof StatusSchema>;

export const SeveritySchema = z.enum(['critical', 'high', 'medium', 'low', 'info']);
export type Severity = z.infer<typeof SeveritySchema>;

/** Provenance tags — lets dashboards/agents filter by what matters */
export const ProvenanceSchema = z.enum(['ai-drift', 'traditional', 'security', 'governance', 'deep-analysis']);
export type Provenance = z.infer<typeof ProvenanceSchema>;

/** Severity weights for score calculation */
export const SEVERITY_WEIGHTS: Record<Severity, number> = {
    critical: 20,
    high: 10,
    medium: 5,
    low: 2,
    info: 0,
};

export const FailureSchema = z.object({
    id: z.string(),
    title: z.string(),
    details: z.string(),
    severity: SeveritySchema.optional(),
    provenance: ProvenanceSchema.optional(),
    files: z.array(z.string()).optional(),
    line: z.number().optional(),
    endLine: z.number().optional(),
    /** The changed line a finding about its enclosing changed function is posted on. */
    anchorLine: z.number().optional(),
    hint: z.string().optional(),
    // Deep analysis fields
    confidence: z.number().min(0).max(1).optional(), // LLM confidence score
    source: z.enum(['ast', 'llm', 'hybrid']).optional(), // Finding source
    category: z.string().optional(), // e.g. 'srp_violation', 'god_function'
    verified: z.boolean().optional(), // AST-verified LLM finding
});
export type Failure = z.infer<typeof FailureSchema>;

export const ReportSchema = z.object({
    status: StatusSchema,
    summary: z.record(StatusSchema),
    failures: z.array(FailureSchema),
    stats: z.object({
        duration_ms: z.number(),
        score: z.number().optional(),
        ai_health_score: z.number().optional(),
        structural_score: z.number().optional(),
        code_quality_score: z.number().optional(), // Deep analysis score
        severity_breakdown: z.record(z.number()).optional(),
        provenance_breakdown: z.object({
            'ai-drift': z.number(),
            traditional: z.number(),
            security: z.number(),
            governance: z.number(),
            'deep-analysis': z.number(),
        }).optional(),
        deep: z.object({
            enabled: z.boolean(),
            /** ok: every inference ran; partial: some failed; error: deep did not run. */
            status: z.enum(['ok', 'partial', 'error']).optional(),
            mode: z.enum(['facts', 'code']).optional(),
            tier: z.enum(['deep', 'lite', 'legacy', 'max', 'cloud']).optional(),
            model: z.string().optional(),
            model_fallback: z.boolean().optional(),
            total_ms: z.number().optional(),
            files_analyzed: z.number().optional(),
            chunks_total: z.number().optional(),
            chunks_failed: z.number().optional(),
            error: z.string().optional(),
            findings_proposed: z.number().optional(), // code mode, before the self-check
            findings_withdrawn: z.number().optional(), // by the self-check
            /** Findings the grounding check dropped, by reason. */
            findings_rejected: z.record(z.number()).optional(),
            /** Files a run budget (`gates.deep.budget_ms`) left unreviewed. */
            files_skipped: z.number().optional(),
            /** Repository lookups the model made in an agentic review. */
            tool_calls: z.number().optional(),
            /** Cloud router: changed functions ranked, how many went to the model, files it left to the gates. */
            router: z.object({ functions: z.number(), routed: z.number(), files_skipped: z.number(), already_reviewed: z.number() }).optional(),
            input_tokens: z.number().optional(),
            output_tokens: z.number().optional(),
            /** Provider-reported cost when available, else tokens × list price; undefined for an unpriced model. */
            cost_usd: z.number().optional(),
            findings_count: z.number().optional(),
            findings_verified: z.number().optional(),
        }).optional(),
    }),
});
export type Report = z.infer<typeof ReportSchema>;

/** Options passed from CLI --deep / --pro / --max / -k flags */
export interface DeepOptions {
    enabled: boolean;
    pro?: boolean;
    /** Local 7B model: the strongest free tier, for laptops with 16GB. */
    max?: boolean;
    /** A local GGUF to run instead of the tier's published model (evaluating a fine-tune before release). */
    modelPath?: string;
    apiKey?: string;
    provider?: string; // 'local' or any cloud provider name
    apiBaseUrl?: string; // custom API endpoint
    modelName?: string; // cloud model name override
    agents?: number; // Number of parallel agents (default: 1). Cloud-only. Each gets own provider instance.
    maxFiles?: number; // Max files to analyze in deep mode (default: 2000). Configurable via rigour.yml: deep.maxFiles
    focusLines?: Record<string, number[]>; // Changed lines per cwd-relative file (from a diff); reviewed first in code mode
    /** Lines the change removed per file, anchored at the new-side line (from a diff). */
    removedLines?: Record<string, Array<{ line: number; text: string[] }>>;
    /** What the change intends (a PR description): reference for the stronger tiers. */
    prBody?: string;
    /**
     * Review every risky changed function, ignoring the review ledger and reviewed.json. Those
     * record what an agent said it reviewed; an enforcing check reviews independently.
     */
    independent?: boolean;
    /** The change's unified diff (from reviewChange): a cloud agentic review reads the PR as a whole. */
    diff?: string;
}
