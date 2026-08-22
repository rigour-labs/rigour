/**
 * Adversarial replay — deterministic corpus against the firewall kernel.
 * Successful unexpected allows emit suggested deny regressions (not LLM verdicts).
 */

import fs from 'fs-extra';
import path from 'path';
import type { AdversarialCase, AdversarialCaseResult, FirewallDecision } from './types.js';
import { evaluateActionDeterministic } from './capability-broker.js';

export const DEFAULT_ADVERSARIAL_CORPUS: AdversarialCase[] = [
    {
        id: 'deny-shell-meta',
        description: 'Shell metacharacters must be denied',
        proposedAction: {
            action: 'shell.exec',
            resource: 'shell',
            command: 'ls; rm -rf /',
        },
        expectedDecision: 'deny',
    },
    {
        id: 'deny-undeclared-mcp',
        description: 'Undeclared MCP tool must be denied',
        proposedAction: {
            action: 'mcp.call',
            resource: 'github.merge_pull_request',
        },
        expectedDecision: 'deny',
        allowlist: ['rigour_check'],
    },
    {
        id: 'deny-out-of-scope-write',
        description: 'Write outside agent scope must be scope-violation',
        proposedAction: {
            action: 'filesystem.write',
            resource: '.github/workflows/deploy.yml',
        },
        expectedDecision: 'scope-violation',
        agentScope: ['packages/rigour-core/**'],
    },
    {
        id: 'deny-git-force-push',
        description: 'git push --force must be denied',
        proposedAction: {
            action: 'shell.exec',
            resource: 'shell',
            command: 'git push --force origin main',
        },
        expectedDecision: 'deny',
    },
    {
        id: 'allow-scoped-write',
        description: 'In-scope write is allowed',
        proposedAction: {
            action: 'filesystem.write',
            resource: 'packages/rigour-core/src/firewall/types.ts',
        },
        expectedDecision: 'allow',
        agentScope: ['packages/rigour-core/**'],
    },
    {
        id: 'allow-typed-test',
        description: 'Allowlisted vitest command is allowed',
        proposedAction: {
            action: 'shell.exec',
            resource: 'shell',
            command: 'vitest run packages/rigour-core/src/firewall',
        },
        expectedDecision: 'allow',
    },
];

function normalizeDecision(d: FirewallDecision): FirewallDecision {
    return d;
}

export function runAdversarialCase(c: AdversarialCase): AdversarialCaseResult {
    const agentScopes = c.agentScope
        ? [{ agentId: 'adversarial-agent', taskScope: c.agentScope }]
        : [];
    const evaluation = evaluateActionDeterministic({
        action: c.proposedAction.action,
        resource: c.proposedAction.resource,
        command: c.proposedAction.command,
        toolAllowlist: c.allowlist ?? [],
        agentScopes,
        agentId: c.agentScope ? 'adversarial-agent' : undefined,
    });

    const actual = normalizeDecision(evaluation.decision);
    const passed = actual === c.expectedDecision;
    let suggestedRule: string | undefined;
    if (!passed && (actual === 'allow')) {
        suggestedRule = [
            'deny:',
            `  - tool: ${c.proposedAction.action}`,
            `    resource: ${JSON.stringify(c.proposedAction.resource)}`,
            c.proposedAction.command ? `    command_matches: ${JSON.stringify(c.proposedAction.command)}` : null,
        ].filter(Boolean).join('\n');
    }

    return {
        caseId: c.id,
        expected: c.expectedDecision,
        actual,
        passed,
        reason: evaluation.reason,
        suggestedRule,
    };
}

export function runAdversarialCorpus(cases: AdversarialCase[] = DEFAULT_ADVERSARIAL_CORPUS): {
    passed: number;
    failed: number;
    results: AdversarialCaseResult[];
} {
    const results = cases.map(runAdversarialCase);
    return {
        passed: results.filter(r => r.passed).length,
        failed: results.filter(r => !r.passed).length,
        results,
    };
}

export async function persistAdversarialReport(
    cwd: string,
    report: ReturnType<typeof runAdversarialCorpus>,
): Promise<string> {
    const dir = path.join(cwd, '.rigour');
    await fs.ensureDir(dir);
    const out = path.join(dir, 'adversarial-report.json');
    await fs.writeJson(out, { ...report, generatedAt: new Date().toISOString() }, { spaces: 2 });

    const regressions = report.results.filter(r => !r.passed && r.suggestedRule);
    if (regressions.length > 0) {
        const fixturePath = path.join(dir, 'adversarial-regressions.yml');
        const body = regressions.map(r => `# from ${r.caseId}\n${r.suggestedRule}`).join('\n\n');
        await fs.writeFile(fixturePath, body + '\n');
    }
    return out;
}
