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
        min_file_lines: z.number().optional().default(100),
        degradation_threshold: z.number().min(0).max(1).optional().default(0.4),
        signals_required: z.number().optional().default(2),
    }).optional().default({}),
    promise_safety: z.object({
        enabled: z.boolean().optional().default(true),
        check_unhandled_then: z.boolean().optional().default(true),
        check_unsafe_parse: z.boolean().optional().default(true),
        check_async_without_await: z.boolean().optional().default(true),
        check_unsafe_fetch: z.boolean().optional().default(true),
        ignore_patterns: z.array(z.string()).optional().default([]),
    }).optional().default({}),
});

export const CommandsSchema = z.object({
    format: z.string().optional(),
    lint: z.string().optional(),
    typecheck: z.string().optional(),
    test: z.string().optional(),
});

export const ConfigSchema = z.object({
    version: z.number().default(1),
    preset: z.string().optional(),
    paradigm: z.string().optional(),
    commands: CommandsSchema.optional().default({}),
    gates: GatesSchema.optional().default({}),
    output: z.object({
        report_path: z.string().default('rigour-report.json'),
    }).optional().default({}),
    planned: z.array(z.string()).optional().default([]),
    ignore: z.array(z.string()).optional().default([]),
});

export type Gates = z.infer<typeof GatesSchema>;
export type Commands = z.infer<typeof CommandsSchema>;
export type Config = z.infer<typeof ConfigSchema>;

export type RawGates = z.input<typeof GatesSchema>;
export type RawCommands = z.input<typeof CommandsSchema>;
export type RawConfig = z.input<typeof ConfigSchema>;

export const StatusSchema = z.enum(['PASS', 'FAIL', 'SKIP', 'ERROR']);
export type Status = z.infer<typeof StatusSchema>;

export const SeveritySchema = z.enum(['critical', 'high', 'medium', 'low', 'info']);
export type Severity = z.infer<typeof SeveritySchema>;

/** Provenance tags — lets dashboards/agents filter by what matters */
export const ProvenanceSchema = z.enum(['ai-drift', 'traditional', 'security', 'governance']);
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
    hint: z.string().optional(),
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
        severity_breakdown: z.record(z.number()).optional(),
        provenance_breakdown: z.object({
            'ai-drift': z.number(),
            traditional: z.number(),
            security: z.number(),
            governance: z.number(),
        }).optional(),
    }),
});
export type Report = z.infer<typeof ReportSchema>;
