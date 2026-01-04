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
});

export type Gates = z.infer<typeof GatesSchema>;
export type Commands = z.infer<typeof CommandsSchema>;
export type Config = z.infer<typeof ConfigSchema>;

export const StatusSchema = z.enum(['PASS', 'FAIL', 'SKIP', 'ERROR']);
export type Status = z.infer<typeof StatusSchema>;

export const FailureSchema = z.object({
    id: z.string(),
    title: z.string(),
    details: z.string(),
    files: z.array(z.string()).optional(),
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
    }),
});
export type Report = z.infer<typeof ReportSchema>;
