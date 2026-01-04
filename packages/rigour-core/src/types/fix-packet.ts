import { z } from 'zod';

/**
 * Fix Packet v2 Schema
 * Designed for high-fidelity communication with AI agents during the refinement loop.
 */
export const FixPacketV2Schema = z.object({
    version: z.literal(2),
    goal: z.string().default('Achieve PASS state for all quality gates'),
    violations: z.array(z.object({
        id: z.string(),
        gate: z.string(),
        severity: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),
        category: z.string().optional(),
        title: z.string(),
        details: z.string(),
        files: z.array(z.string()).optional(),
        hint: z.string().optional(),
        instructions: z.array(z.string()).optional(), // Step-by-step fix instructions
        metrics: z.record(z.any()).optional(), // e.g., { complexity: 15, max: 10 }
    })),
    constraints: z.object({
        protected_paths: z.array(z.string()).optional(),
        do_not_touch: z.array(z.string()).optional(), // Alias for protected_paths
        max_files_changed: z.number().optional(),
        no_new_deps: z.boolean().optional().default(true),
        allowed_dependencies: z.array(z.string()).optional(),
        paradigm: z.string().optional(), // 'oop', 'functional'
    }).optional().default({}),
});

export type FixPacketV2 = z.infer<typeof FixPacketV2Schema>;
