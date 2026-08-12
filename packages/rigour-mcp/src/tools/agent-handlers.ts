/**
 * Multi-Agent Governance Tool Handlers
 *
 * Handlers for: rigour_agent_register, rigour_checkpoint, rigour_handoff,
 * rigour_agent_deregister, rigour_handoff_accept
 *
 * @since v2.17.0 — extracted from monolithic index.ts
 */
import fs from "fs-extra";
import path from "path";
import { logStudioEvent } from '../utils/config.js';
import {
    setTaskCheckpointCache,
    getTaskCheckpointCache,
    estimateTokenCount,
} from '@rigour-labs/core';
import {
    PatternIndexer,
    savePatternIndex,
    loadPatternIndex,
    getDefaultIndexPath,
} from '@rigour-labs/core/pattern-index';
import { buildTelemetryMeta, getWorkspaceCommitSha, type ToolResult } from '../utils/context-telemetry.js';
import { appendContextFooter } from '../utils/context-footer.js';

const HANDOFF_CONTEXT_TOKEN_LIMIT = 2000;

function parseJsonOrNull<T>(raw: string): T | null {
    try {
        return JSON.parse(raw) as T;
    } catch {
        return null;
    }
}

function globMatchesFile(filePath: string, glob: string): boolean {
    const normalized = filePath.replace(/\\/g, '/');
    const pattern = glob
        .replace(/\\/g, '/')
        .replace(/\./g, '\\.')
        .replace(/\*\*/g, '§§')
        .replace(/\*/g, '[^/]*')
        .replace(/§§/g, '.*');
    if (new RegExp(`^${pattern}$`).test(normalized)) return true;
    const prefix = glob.replace('/**', '').replace('/*', '').replace(/\*/g, '');
    return normalized.startsWith(prefix);
}

async function refreshIndexForFiles(cwd: string, filesChanged: string[]): Promise<string | null> {
    if (filesChanged.length === 0) return null;

    const indexPath = getDefaultIndexPath(cwd);
    const existingIndex = await loadPatternIndex(indexPath);
    if (!existingIndex) {
        return 'Index not found — run rigour_index to enable incremental updates.';
    }

    try {
        const indexer = new PatternIndexer(cwd, { useEmbeddings: existingIndex.patterns.some(p => p.embedding?.length) });
        const updated = await indexer.updateIndex(existingIndex);
        await savePatternIndex(updated, indexPath);
        return `Index refreshed for ${filesChanged.length} changed file(s) — ${updated.stats.totalPatterns} patterns total.`;
    } catch (error: any) {
        return `Index refresh failed: ${error.message}`;
    }
}

async function validateTaskScopeAgainstIndex(cwd: string, taskScope: string[]): Promise<{
    matchedFiles: string[];
    unmatchedGlobs: string[];
    suggestions: string[];
}> {
    const index = await loadPatternIndex(getDefaultIndexPath(cwd));
    if (!index) {
        return { matchedFiles: [], unmatchedGlobs: taskScope, suggestions: ['Run rigour_index first to bind scope to indexed files.'] };
    }

    const indexedFiles = index.files.map(f => f.path);
    const matchedFiles: string[] = [];
    const unmatchedGlobs: string[] = [];

    for (const glob of taskScope) {
        const matches = indexedFiles.filter(f => globMatchesFile(f, glob));
        if (matches.length > 0) {
            matchedFiles.push(...matches);
        } else {
            unmatchedGlobs.push(glob);
        }
    }

    const uniqueMatched = Array.from(new Set(matchedFiles));
    const suggestions: string[] = [];
    if (uniqueMatched.length > 0 && uniqueMatched.length <= 8) {
        suggestions.push(`Minimal scope: ${uniqueMatched.slice(0, 8).join(', ')}`);
    }
    if (unmatchedGlobs.length > 0) {
        suggestions.push(`Unmatched globs (not in index): ${unmatchedGlobs.join(', ')}`);
    }

    return { matchedFiles: uniqueMatched, unmatchedGlobs, suggestions };
}

// ─── Agent Register ───────────────────────────────────────────────

export async function handleAgentRegister(
    cwd: string, agentId: string, taskScope: string[], requestId: string
): Promise<ToolResult> {
    const {
        validateAgentClaimedScope,
        loadOperatorScopes,
        isScopeSubset,
    } = await import('@rigour-labs/core');

    const authority = process.env.RIGOUR_ALLOW_AGENT_SCOPE_AUTHORITY === '1';
    if (!authority) {
        const claimCheck = validateAgentClaimedScope(taskScope);
        if (!claimCheck.ok) {
            await logStudioEvent(cwd, {
                type: 'firewall_deny',
                requestId,
                tool: 'rigour_agent_register',
                decision: 'deny',
                reason: claimCheck.reason,
                ruleId: 'scope.register-denied',
            });
            return {
                content: [{ type: 'text', text: `❌ SCOPE REGISTER DENIED: ${claimCheck.reason}` }],
                isError: true,
            };
        }
    }

    const operatorScopes = await loadOperatorScopes(cwd);
    if (operatorScopes) {
        const allowed = operatorScopes[agentId];
        if (!allowed || !isScopeSubset(taskScope, allowed)) {
            const msg = allowed
                ? `Claimed scope is not a subset of operator scopes for "${agentId}": ${allowed.join(', ')}`
                : `No operator scopes defined for agent "${agentId}" in .rigour/operator-scopes.json`;
            await logStudioEvent(cwd, {
                type: 'firewall_deny',
                requestId,
                tool: 'rigour_agent_register',
                decision: 'deny',
                reason: msg,
                ruleId: 'scope.operator-required',
            });
            return {
                content: [{ type: 'text', text: `❌ SCOPE REGISTER DENIED: ${msg}` }],
                isError: true,
            };
        }
    }

    const sessionPath = path.join(cwd, '.rigour', 'agent-session.json');
    let session = { agents: [] as any[], startedAt: new Date().toISOString() };

    if (await fs.pathExists(sessionPath)) {
        const parsed = parseJsonOrNull<typeof session>(await fs.readFile(sessionPath, 'utf-8'));
        if (parsed) {
            session = parsed;
        }
    }

    const indexBinding = await validateTaskScopeAgainstIndex(cwd, taskScope);

    const existingIdx = session.agents.findIndex((a: any) => a.agentId === agentId);
    if (existingIdx >= 0) {
        session.agents[existingIdx] = {
            agentId, taskScope,
            registeredAt: session.agents[existingIdx].registeredAt,
            lastCheckpoint: new Date().toISOString(),
            indexBinding: {
                matchedFiles: indexBinding.matchedFiles.length,
                unmatchedGlobs: indexBinding.unmatchedGlobs,
            },
        };
    } else {
        session.agents.push({
            agentId, taskScope,
            registeredAt: new Date().toISOString(),
            lastCheckpoint: new Date().toISOString(),
            indexBinding: {
                matchedFiles: indexBinding.matchedFiles.length,
                unmatchedGlobs: indexBinding.unmatchedGlobs,
            },
        });
    }

    // Scope conflict detection
    const conflicts: string[] = [];
    for (const agent of session.agents) {
        if (agent.agentId !== agentId) {
            for (const scope of taskScope) {
                if (agent.taskScope.includes(scope)) {
                    conflicts.push(`${agent.agentId} also claims "${scope}"`);
                }
            }
        }
    }

    await fs.ensureDir(path.join(cwd, '.rigour'));
    await fs.writeFile(sessionPath, JSON.stringify(session, null, 2));

    await logStudioEvent(cwd, { type: "agent_registered", requestId, agentId, taskScope, conflicts, indexBinding });

    let text = `✅ AGENT REGISTERED: "${agentId}" claimed scope: ${taskScope.join(', ')}\n\n`;
    text += `Active agents in session: ${session.agents.length}\n`;
    if (indexBinding.matchedFiles.length > 0) {
        text += `\n📎 Index binding: ${indexBinding.matchedFiles.length} indexed file(s) matched.\n`;
        if (indexBinding.suggestions.length > 0) {
            text += indexBinding.suggestions.map(s => `  - ${s}`).join('\n') + '\n';
        }
    } else if (indexBinding.suggestions.length > 0) {
        text += `\n⚠️ ${indexBinding.suggestions.join(' ')}\n`;
    }
    if (conflicts.length > 0) {
        text += `\n⚠️ SCOPE CONFLICTS DETECTED:\n${conflicts.map(c => `  - ${c}`).join('\n')}\n`;
        text += `\nConsider coordinating with other agents or narrowing your scope.`;
    }

    const telemetry = buildTelemetryMeta({
        candidateText: taskScope.join(' '),
        returnedText: text,
        cacheStatus: 'none',
    });

    return {
        content: [{ type: "text", text: appendContextFooter(text, telemetry, 'rigour_recall then rigour_context_scope') }],
        _telemetry: telemetry,
    };
}

// ─── Checkpoint ───────────────────────────────────────────────────

export async function handleCheckpoint(
    cwd: string,
    progressPct: number,
    filesChanged: string[],
    summary: string,
    qualityScore: number,
    requestId: string,
    agentId = 'default-agent',
    taskId = 'default-task',
): Promise<ToolResult> {
    const checkpointPath = path.join(cwd, '.rigour', 'checkpoint-session.json');
    let session = {
        sessionId: `chk-session-${Date.now()}`,
        startedAt: new Date().toISOString(),
        checkpoints: [] as any[],
        status: 'active',
    };

    if (await fs.pathExists(checkpointPath)) {
        const parsed = parseJsonOrNull<typeof session>(await fs.readFile(checkpointPath, 'utf-8'));
        if (parsed) {
            session = parsed;
        }
    }

    const checkpointId = `cp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const warnings: string[] = [];

    if (qualityScore < 80) {
        warnings.push(`Quality score ${qualityScore}% is below threshold 80%`);
    }

    // Drift detection
    if (session.checkpoints.length >= 2) {
        const recentScores = session.checkpoints.slice(-3).map((cp: any) => cp.qualityScore);
        const avgRecent = recentScores.reduce((a: number, b: number) => a + b, 0) / recentScores.length;
        if (qualityScore < avgRecent - 10) {
            warnings.push(`Drift detected: quality dropped from avg ${avgRecent.toFixed(0)}% to ${qualityScore}%`);
        }
    }

    const rawStateText = JSON.stringify(session);
    const phase = `progress-${progressPct}`;

    session.checkpoints.push({
        checkpointId,
        timestamp: new Date().toISOString(),
        progressPct, filesChanged, summary, qualityScore, warnings,
    });

    await fs.ensureDir(path.join(cwd, '.rigour'));
    await fs.writeFile(checkpointPath, JSON.stringify(session, null, 2));

    await setTaskCheckpointCache({
        taskId,
        agentId,
        phase,
        component: filesChanged[0] ? path.dirname(filesChanged[0]) : 'workspace',
        changedFiles: filesChanged,
        decisions: [summary],
        validation: ['rigour_check'],
        remainingWork: [`Continue from ${progressPct}%`],
        risks: warnings,
    }, estimateTokenCount(rawStateText), cwd);

    let indexNote: string | null = null;
    if (filesChanged.length > 0) {
        indexNote = await refreshIndexForFiles(cwd, filesChanged);
    }

    await logStudioEvent(cwd, { type: "checkpoint_recorded", requestId, checkpointId, progressPct, qualityScore, warnings, filesChanged });

    let text = `📍 CHECKPOINT RECORDED: ${checkpointId}\n\n`;
    text += `Progress: ${progressPct}% | Quality: ${qualityScore}%\n`;
    text += `Summary: ${summary}\n`;
    text += `Total checkpoints: ${session.checkpoints.length}\n`;
    if (indexNote) text += `\n${indexNote}\n`;
    if (warnings.length > 0) {
        text += `\n⚠️ WARNINGS:\n${warnings.map(w => `  - ${w}`).join('\n')}\n`;
        if (qualityScore < 80) text += `\n⛔ QUALITY BELOW THRESHOLD: Consider pausing and reviewing recent work.`;
    }

    const packet = await getTaskCheckpointCache(taskId, agentId, phase, cwd);
    const returnedText = packet ? JSON.stringify(packet) : text;
    const telemetry = buildTelemetryMeta({
        candidateText: rawStateText,
        returnedText,
        cacheStatus: 'miss',
        deduplicatedTokens: Math.max(0, estimateTokenCount(rawStateText) - estimateTokenCount(returnedText)),
    });

    const result: ToolResult = {
        content: [{ type: "text", text: appendContextFooter(text, telemetry, 'rigour_handoff with compact context') }],
        _telemetry: telemetry,
    };
    result._shouldContinue = qualityScore >= 80;
    return result;
}

// ─── Handoff ──────────────────────────────────────────────────────

export async function handleHandoff(
    cwd: string,
    fromAgentId: string,
    toAgentId: string,
    taskDescription: string,
    filesInScope: string[],
    context: string,
    requestId: string,
    taskId = 'default-task',
): Promise<ToolResult> {
    const contextTokens = estimateTokenCount(context);
    if (contextTokens > HANDOFF_CONTEXT_TOKEN_LIMIT) {
        const text = `🛑 HANDOFF REJECTED: context is ~${contextTokens} tokens (limit: ${HANDOFF_CONTEXT_TOKEN_LIMIT}).\n\n`
            + `Call rigour_checkpoint first to compress state into a checkpoint packet, then hand off with a brief summary only.\n`
            + `Subagents should receive checkpoint packets — not parent transcripts.`;
        return {
            content: [{ type: 'text', text }],
            isError: true,
            _telemetry: buildTelemetryMeta({
                candidateText: context,
                returnedText: text,
                cacheStatus: 'none',
            }),
        };
    }

    const handoffId = `handoff-${Date.now()}`;
    const handoffPath = path.join(cwd, '.rigour', 'handoffs.jsonl');
    const commitSha = await getWorkspaceCommitSha(cwd);

    const checkpointPacket = await getTaskCheckpointCache(taskId, fromAgentId, `progress-100`, cwd)
        ?? await getTaskCheckpointCache(taskId, fromAgentId, `progress-75`, cwd);

    const compactContext = checkpointPacket
        ? JSON.stringify({
            decisions: checkpointPacket.decisions,
            changedFiles: checkpointPacket.changedFiles,
            remainingWork: checkpointPacket.remainingWork,
            risks: checkpointPacket.risks,
            brief: context.slice(0, 500),
        })
        : context;

    const handoff = {
        handoffId,
        timestamp: new Date().toISOString(),
        fromAgentId, toAgentId, taskDescription, filesInScope,
        context: compactContext,
        checkpointBound: !!checkpointPacket,
        commitSha,
        status: 'pending',
    };

    await fs.ensureDir(path.join(cwd, '.rigour'));
    await fs.appendFile(handoffPath, JSON.stringify(handoff) + '\n');

    await logStudioEvent(cwd, { type: "handoff_initiated", requestId, handoffId, fromAgentId, toAgentId, taskDescription, contextTokens });

    let text = `🤝 HANDOFF INITIATED: ${handoffId}\n\n`;
    text += `From: ${fromAgentId} → To: ${toAgentId}\n`;
    text += `Task: ${taskDescription}\n`;
    if (filesInScope.length > 0) text += `Files in scope: ${filesInScope.join(', ')}\n`;
    if (compactContext) text += `Context: ${compactContext}\n`;
    if (checkpointPacket) text += `\n✅ Checkpoint packet attached (compressed handoff).\n`;
    text += `\nThe receiving agent should call rigour_agent_register to claim this scope.`;

    const telemetry = buildTelemetryMeta({
        candidateText: context || taskDescription,
        returnedText: compactContext || text,
        cacheStatus: checkpointPacket ? 'partial-hit' : 'miss',
        deduplicatedTokens: Math.max(0, contextTokens - estimateTokenCount(compactContext)),
    });

    return {
        content: [{ type: "text", text: appendContextFooter(text, telemetry, 'rigour_handoff_accept') }],
        _telemetry: telemetry,
    };
}

// ─── Agent Deregister ─────────────────────────────────────────────

export async function handleAgentDeregister(cwd: string, agentId: string, requestId: string): Promise<ToolResult> {
    const sessionPath = path.join(cwd, '.rigour', 'agent-session.json');

    if (!await fs.pathExists(sessionPath)) {
        return { content: [{ type: "text", text: `❌ No active agent session found.` }] };
    }

    const session = parseJsonOrNull<any>(await fs.readFile(sessionPath, 'utf-8'));
    if (!session || !Array.isArray(session.agents)) {
        return { content: [{ type: "text", text: `❌ Agent session file is malformed.` }], isError: true };
    }
    const initialCount = session.agents.length;
    session.agents = session.agents.filter((a: any) => a.agentId !== agentId);

    if (session.agents.length === initialCount) {
        return { content: [{ type: "text", text: `❌ Agent "${agentId}" not found in session.` }] };
    }

    await fs.writeFile(sessionPath, JSON.stringify(session, null, 2));

    await logStudioEvent(cwd, { type: "agent_deregistered", requestId, agentId, remainingAgents: session.agents.length });

    let text = `✅ AGENT DEREGISTERED: "${agentId}" has been removed from the session.\n\n`;
    text += `Remaining agents: ${session.agents.length}\n`;
    if (session.agents.length > 0) {
        text += `Active: ${session.agents.map((a: any) => a.agentId).join(', ')}`;
    }

    return { content: [{ type: "text", text }] };
}

// ─── Handoff Accept ───────────────────────────────────────────────

export async function handleHandoffAccept(cwd: string, handoffId: string, agentId: string, requestId: string): Promise<ToolResult> {
    const handoffPath = path.join(cwd, '.rigour', 'handoffs.jsonl');

    if (!await fs.pathExists(handoffPath)) {
        return { content: [{ type: "text", text: `❌ No handoffs found.` }] };
    }

    const content = await fs.readFile(handoffPath, 'utf-8');
    const handoffs = content
        .trim()
        .split('\n')
        .filter(l => l)
        .map(line => parseJsonOrNull<any>(line))
        .filter((entry): entry is any => !!entry);

    const handoff = handoffs.find((h: any) => h.handoffId === handoffId);
    if (!handoff) {
        return { content: [{ type: "text", text: `❌ Handoff "${handoffId}" not found.` }] };
    }

    if (handoff.toAgentId !== agentId) {
        return {
            content: [{ type: "text", text: `❌ Agent "${agentId}" is not the intended recipient.\nHandoff is for: ${handoff.toAgentId}` }],
            isError: true,
        };
    }

    handoff.status = 'accepted';
    handoff.acceptedAt = new Date().toISOString();
    handoff.acceptedBy = agentId;

    const updatedContent = handoffs.map((h: any) => JSON.stringify(h)).join('\n') + '\n';
    await fs.writeFile(handoffPath, updatedContent);

    await logStudioEvent(cwd, { type: "handoff_accepted", requestId, handoffId, acceptedBy: agentId, fromAgentId: handoff.fromAgentId });

    let text = `✅ HANDOFF ACCEPTED: ${handoffId}\n\n`;
    text += `From: ${handoff.fromAgentId}\nTask: ${handoff.taskDescription}\n`;
    if (handoff.filesInScope?.length > 0) text += `Files in scope: ${handoff.filesInScope.join(', ')}\n`;
    text += `\nYou should now call rigour_agent_register to formally claim the scope.`;

    return { content: [{ type: "text", text }] };
}
