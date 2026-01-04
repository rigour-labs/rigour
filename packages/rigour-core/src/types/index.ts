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
});

export const CommandsSchema = z.object({
    format: z.string().optional(),
    lint: z.string().optional(),
    typecheck: z.string().optional(),
    test: z.string().optional(),
});

export const ConfigSchema = z.object({
    version: z.number().default(1),
    commands: CommandsSchema.optional().default({}),
    gates: GatesSchema.optional().default({}),
    output: z.object({
        report_path: z.string().default('vibeguard-report.json'),
    }).optional().default({}),
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
    }),
});
export type Report = z.infer<typeof ReportSchema>;
