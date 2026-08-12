/**
 * Enforce agent file ownership against claimed globs.
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

export function normalizeRelPath(cwd: string, filePath: string): string {
    const abs = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
    return path.relative(cwd, abs).replace(/\\/g, '/');
}

export function isPathInScope(relPath: string, globs: string[]): boolean {
    if (!globs || globs.length === 0) return false;
    const normalized = relPath.replace(/\\/g, '/');
    return micromatch.isMatch(normalized, globs, { dot: true });
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
        // No registered agents → no scope firewall (hooks still apply protected paths)
        return {
            decision: 'allow',
            reason: 'No agent scopes registered; scope enforcement inactive',
            ruleId: 'scope.inactive',
            policyHash,
            timestamp,
        };
    }

    const agents = agentId
        ? agentScopes.filter(a => a.agentId === agentId)
        : agentScopes;

    if (agentId && agents.length === 0) {
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
