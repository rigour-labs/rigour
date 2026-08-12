/**
 * Enforce agent file ownership against claimed globs.
 * Fail-closed: when scopes exist, writer agentId is required (no union-allow).
 */

import path from 'path';
import micromatch from 'micromatch';
import fs from 'fs-extra';
import type { PolicyEvaluation } from './types.js';
import { hashPolicy } from './policy-hash.js';

export interface AgentScopeRecord {
    agentId: string;
    taskScope: string[];
}

/** Globs agents may not self-claim without operator authority. */
const FORBIDDEN_AGENT_SCOPES = new Set(['*', '**', '**/*', '**/**', '/*', '/']);

const SENSITIVE_SCOPE_PATTERNS = [
    /^\.github(\/|$|\*\*)/i,
    /(^|\/)\.env/i,
    /(^|\/)secrets?(\/|$|\*\*)/i,
    /^\*\*\/\.github/,
];

export function normalizeRelPath(cwd: string, filePath: string): string {
    const abs = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
    return path.relative(cwd, abs).replace(/\\/g, '/');
}

export function isPathInScope(relPath: string, globs: string[]): boolean {
    if (!globs || globs.length === 0) return false;
    const normalized = relPath.replace(/\\/g, '/');
    return micromatch.isMatch(normalized, globs, { dot: true });
}

export function validateAgentClaimedScope(taskScope: string[]): { ok: true } | { ok: false; reason: string } {
    if (!taskScope.length) {
        return { ok: false, reason: 'taskScope must be a non-empty list of path globs' };
    }
    for (const raw of taskScope) {
        const s = raw.replace(/\\/g, '/').trim();
        if (!s) {
            return { ok: false, reason: 'Empty scope glob is not allowed' };
        }
        if (FORBIDDEN_AGENT_SCOPES.has(s)) {
            return {
                ok: false,
                reason: `Scope "${s}" is too broad for agent self-registration (operator authority required)`,
            };
        }
        if (SENSITIVE_SCOPE_PATTERNS.some(re => re.test(s))) {
            return {
                ok: false,
                reason: `Scope "${s}" covers sensitive paths; set operator scopes or RIGOUR_ALLOW_AGENT_SCOPE_AUTHORITY=1`,
            };
        }
    }
    return { ok: true };
}

/**
 * Operator-controlled allowlist: `.rigour/operator-scopes.json`
 * `{ "agents": { "agent-id": ["packages/foo/**"] } }`
 */
export async function loadOperatorScopes(cwd: string): Promise<Record<string, string[]> | null> {
    const p = path.join(cwd, '.rigour', 'operator-scopes.json');
    if (!(await fs.pathExists(p))) return null;
    try {
        const raw = await fs.readJson(p);
        if (raw?.agents && typeof raw.agents === 'object') {
            return raw.agents as Record<string, string[]>;
        }
    } catch {
        return null;
    }
    return null;
}

export function isScopeSubset(claimed: string[], allowed: string[]): boolean {
    // Each claimed glob must be matched/covered by an allowed glob (exact or nested under allowed prefix)
    return claimed.every(c =>
        allowed.some(a => c === a || c.startsWith(a.replace(/\*\*$/, '').replace(/\*$/, '')) || micromatch.isMatch(c, a, { dot: true })),
    );
}

export function evaluateWriteScope(
    cwd: string,
    filePath: string,
    agentScopes: AgentScopeRecord[],
    agentId?: string,
): PolicyEvaluation {
    const policyHash = hashPolicy({ agentScopes, agentId });
    const rel = normalizeRelPath(cwd, filePath);
    const timestamp = new Date().toISOString();

    if (!agentScopes.length) {
        return {
            decision: 'allow',
            reason: 'No agent scopes registered; scope enforcement inactive',
            ruleId: 'scope.inactive',
            policyHash,
            timestamp,
        };
    }

    if (!agentId) {
        return {
            decision: 'scope-violation',
            reason: 'Writer agentId is required when agent scopes are registered (fail-closed; no union-allow)',
            ruleId: 'scope.unbound',
            policyHash,
            timestamp,
        };
    }

    const agents = agentScopes.filter(a => a.agentId === agentId);
    if (agents.length === 0) {
        return {
            decision: 'scope-violation',
            reason: `Agent "${agentId}" is not registered`,
            ruleId: 'scope.unregistered',
            policyHash,
            timestamp,
        };
    }

    const allowed = agents.some(a => isPathInScope(rel, a.taskScope));
    if (!allowed) {
        const scopes = agents.map(a => `${a.agentId}:[${a.taskScope.join(', ')}]`).join('; ');
        return {
            decision: 'scope-violation',
            reason: `Write to "${rel}" is outside assigned scope (${scopes})`,
            ruleId: 'scope.out-of-bounds',
            policyHash,
            timestamp,
        };
    }

    return {
        decision: 'allow',
        reason: `Path "${rel}" is within assigned agent scope`,
        ruleId: 'scope.allow',
        policyHash,
        timestamp,
    };
}

export async function loadAgentScopesFromDisk(cwd: string): Promise<AgentScopeRecord[]> {
    const sessionPath = path.join(cwd, '.rigour', 'agent-session.json');
    if (!(await fs.pathExists(sessionPath))) return [];
    try {
        const raw = await fs.readJson(sessionPath);
        const agents = Array.isArray(raw?.agents) ? raw.agents : [];
        return agents.map((a: any) => ({
            agentId: String(a.agentId),
            taskScope: Array.isArray(a.taskScope) ? a.taskScope.map(String) : [],
        }));
    } catch {
        return [];
    }
}

export async function assertWritesInScope(
    cwd: string,
    files: string[],
    agentId?: string,
): Promise<PolicyEvaluation> {
    const scopes = await loadAgentScopesFromDisk(cwd);
    for (const file of files) {
        const ev = evaluateWriteScope(cwd, file, scopes, agentId);
        if (ev.decision !== 'allow') return ev;
    }
    return {
        decision: 'allow',
        reason: 'All files within scope',
        ruleId: 'scope.batch-allow',
        policyHash: hashPolicy({ files, agentId }),
        timestamp: new Date().toISOString(),
    };
}
