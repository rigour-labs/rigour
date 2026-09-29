/**
 * Turns a learned rule (data) into a semantic rule the engine runs.
 */
import ts from 'typescript';
import { forEachNode, lineOf, relativeFile, snippet } from '../ast.js';
import type { RuleContext, SemanticFinding, SemanticRule } from '../types.js';
import { guardsOf, mentionsName, namesIn, propertiesNamed, setsProperty } from './conditions.js';
import { calleeKey, functionKeyOf, invocationArgs, isInvocation, type Invocation } from './identity.js';
import type { LearnedPattern, LearnedRule } from './types.js';

export const LEARNED_PREFIX = 'learned/';

export function compileLearnedRule(rule: LearnedRule): SemanticRule {
    const id = `${LEARNED_PREFIX}${rule.id}`;
    return {
        id,
        check(ctx: RuleContext): SemanticFinding[] {
            const findings: SemanticFinding[] = [];
            const file = relativeFile(ctx.cwd, ctx.sourceFile);
            if (rule.pattern.scope && rule.pattern.scope.file !== file) return findings;
            forEachNode(ctx.sourceFile, (node) => {
                if (!isInvocation(node) || !matchesCall(ctx, rule.pattern, node)) return;
                const at = violation(ctx, rule.pattern, node);
                if (!at) return;
                findings.push({
                    rule: id,
                    severity: rule.severity,
                    provenance: 'traditional',
                    file,
                    line: lineOf(at),
                    message: rule.message,
                    hint: `Learned from ${describeSource(rule)}. Apply the same fix here, or delete .rigour/rules/${rule.id}.json if the rule no longer holds.`,
                    evidence: [`${file}:${lineOf(node)} ${snippet(node)}`],
                });
            });
            return findings;
        },
    };
}

function matchesCall(ctx: RuleContext, pattern: LearnedPattern, call: Invocation): boolean {
    if (pattern.scope && functionKeyOf(call) !== pattern.scope.fn) return false;
    return calleeKey(ctx.checker, ctx.cwd, call, pattern.callee.level) === pattern.callee.key;
}

/** The node that breaks the rule in `call`, or undefined when the call complies. */
function violation(ctx: RuleContext, pattern: LearnedPattern, call: Invocation): ts.Node | undefined {
    const args = invocationArgs(call);
    if (pattern.template === 'require-option') {
        return setsProperty(ctx.checker, args[pattern.argIndex], pattern.property) ? undefined : call;
    }
    for (const prop of args.flatMap(arg => propertiesNamed(arg, pattern.property))) {
        const applies = !pattern.appliesWhenArgsMention || args.some(arg => mentionsName(arg, pattern.guard, prop));
        if (applies && !namesIn(guardsOf(prop, call)).includes(pattern.guard)) return prop;
    }
    return undefined;
}

function describeSource(rule: LearnedRule): string {
    const where = `${rule.source.file} (${rule.source.function})`;
    return rule.source.commit ? `fix ${rule.source.commit.slice(0, 8)} in ${where}` : `a fix in ${where}`;
}
