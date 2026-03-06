import { z } from 'zod';

/**
 * Fix Packet v3 Schema
 *
 * Designed for high-fidelity, machine-readable communication with AI agents.
 * Every violation tells the agent exactly: who failed, which files, what rule,
 * where in the file, and what must pass to verify the fix.
 *
 * v3 changes from v2:
 *   - Violations now include `location` (file + line range) for precise targeting
 *   - Top-level `verification` block: commands the agent MUST run after fixing
 *   - `allowed_scope`: explicit list of file globs the agent IS allowed to edit
 *   - `failed_gates`: summary list of gate IDs that failed (quick machine check)
 */

const ViolationLocationSchema = z.object({
    file: z.string(),
    line: z.number().optional(),
    endLine: z.number().optional(),
});

const ViolationSchema = z.object({
    id: z.string(),                   // Gate ID, e.g. "file-size"
    gate: z.string(),                 // Same as id (kept for backwards compat)
    severity: z.enum(['info', 'low', 'medium', 'high', 'critical']).default('medium'),
    category: z.string().optional(),  // Provenance: "traditional", "ai-drift", "security", etc.
    title: z.string(),
    details: z.string(),
    files: z.array(z.string()).optional(),
    locations: z.array(ViolationLocationSchema).optional(), // Precise file + line targets
    hint: z.string().optional(),
    instructions: z.array(z.string()).optional(),
    metrics: z.record(z.any()).optional(), // e.g. { complexity: 15, threshold: 10 }
});

const VerificationSchema = z.object({
    commands: z.array(z.object({
        cmd: z.string(),              // e.g. "npm run typecheck"
        purpose: z.string(),          // e.g. "Ensure no TypeScript errors"
    })),
    gate_command: z.string().default('rigour_check'), // The rigour tool to re-run
});

export const FixPacketV2Schema = z.object({
    version: z.literal(3),
    goal: z.string().default('Achieve PASS state for all quality gates'),
    failed_gates: z.array(z.string()), // Quick list: ["file-size", "hallucinated-imports"]
    violations: z.array(ViolationSchema),
    verification: VerificationSchema.optional(),
    constraints: z.object({
        protected_paths: z.array(z.string()).optional(),
        do_not_touch: z.array(z.string()).optional(),
        allowed_scope: z.array(z.string()).optional(), // Globs the agent IS allowed to edit
        max_files_changed: z.number().optional(),
        no_new_deps: z.boolean().optional().default(true),
        allowed_dependencies: z.array(z.string()).optional(),
        paradigm: z.string().optional(),
    }).optional().default({}),
});

export type FixPacketV2 = z.infer<typeof FixPacketV2Schema>;
export type Violation = z.infer<typeof ViolationSchema>;
export type ViolationLocation = z.infer<typeof ViolationLocationSchema>;
