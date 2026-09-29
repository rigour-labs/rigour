/**
 * Rules learned from a fix: a before/after pair turned into a check.
 *
 * A learned rule is data (`.rigour/rules/<id>.json`), reviewed in pull
 * requests like code. It is kept only when it fires on the code before the
 * fix, is silent on the fixed code, and fires on few other places in the
 * repository; the validation that proved this is stored with it.
 */
import { z } from 'zod';

/** How a call is recognised: by its name, the declaration it resolves to, or its exact text. */
export const CalleeMatcherSchema = z.object({
    level: z.enum(['name', 'declaration', 'text']),
    key: z.string().min(1),
});

/** Narrows a rule to one function in one file: a regression guard for the fixed code. */
export const ScopeSchema = z.object({
    file: z.string().min(1),
    fn: z.string().min(1),
});

export const RequireOptionSchema = z.object({
    template: z.literal('require-option'),
    callee: CalleeMatcherSchema,
    argIndex: z.number().int().min(0),
    property: z.string().min(1),
    value: z.string().optional(),
    scope: ScopeSchema.optional(),
});

export const RequireGuardSchema = z.object({
    template: z.literal('require-guard'),
    callee: CalleeMatcherSchema,
    property: z.string().min(1),
    guard: z.string().min(1),
    /** Apply only where the call's other arguments mention `guard` (e.g. the body carries it). */
    appliesWhenArgsMention: z.boolean(),
    scope: ScopeSchema.optional(),
});

export const LearnedPatternSchema = z.discriminatedUnion('template', [RequireOptionSchema, RequireGuardSchema]);

export const LearnedRuleSchema = z.object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    version: z.literal(1),
    pattern: LearnedPatternSchema,
    message: z.string(),
    severity: z.enum(['low', 'medium', 'high']),
    source: z.object({
        commit: z.string().optional(),
        file: z.string(),
        function: z.string(),
    }),
    validation: z.object({
        firesBefore: z.number().int(),
        firesAfter: z.number().int(),
        maxHits: z.number().int(),
        repoHits: z.array(z.string()),
    }),
});

export type CalleeMatcher = z.infer<typeof CalleeMatcherSchema>;
export type LearnedPattern = z.infer<typeof LearnedPatternSchema>;
export type LearnedRule = z.infer<typeof LearnedRuleSchema>;
