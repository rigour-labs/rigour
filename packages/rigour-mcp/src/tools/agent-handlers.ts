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

type ToolResult = { content: { type: string; text: string }[]; isError?: boolean; _shouldContinue?: boolean };

// ─── Agent Register ───────────────────────────────────────────────

export async function handleAgentRegister(
    cwd: string, agentId: string, taskScope: string[], requestId: string
): Promise<ToolResult> {
    const sessionPath = path.join(cwd, '.rigour', 'agent-session.json');
    let session = { agents: [] as any[], startedAt: new Date().toISOString() };

    if (await fs.pathExists(sessionPath)) {
        session = JSON.parse(await fs.readFile(sessionPath, 'utf-8'));
    }

    const existingIdx = session.agents.findIndex((a: any) => a.agentId === agentId);
    if (existingIdx >= 0) {
        session.agents[existingIdx] = {
            agentId, taskScope,
            registeredAt: session.agents[existingIdx].registeredAt,
            lastCheckpoint: new Date().toISOString(),
        };
    } else {
        session.agents.push({
            agentId, taskScope,
            registeredAt: new Date().toISOString(),
            lastCheckpoint: new Date().toISOString(),
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

    await logStudioEvent(cwd, { type: "agent_registered", requestId, agentId, taskScope, conflicts });

    let text = `✅ AGENT REGISTERED: "${agentId}" claimed scope: ${taskScope.join(', ')}\n\n`;
    text += `Active agents in session: ${session.agents.length}\n`;
    if (conflicts.length > 0) {
        text += `\n⚠️ SCOPE CONFLICTS DETECTED:\n${conflicts.map(c => `  - ${c}`).join('\n')}\n`;
        text += `\nConsider coordinating with other agents or narrowing your scope.`;
    }

    return { content: [{ type: "text", text }] };
}

// ─── Checkpoint ───────────────────────────────────────────────────

export async function handleCheckpoint(
    cwd: string,
    progressPct: number,
    filesChanged: string[],
    summary: string,
    qualityScore: number,
    requestId: string
): Promise<ToolResult> {
    const checkpointPath = path.join(cwd, '.rigour', 'checkpoint-session.json');
    let session = {
        sessionId: `chk-session-${Date.now()}`,
        startedAt: new Date().toISOString(),
        checkpoints: [] as any[],
        status: 'active',
    };

    if (await fs.pathExists(checkpointPath)) {
        session = JSON.parse(await fs.readFile(checkpointPath, 'utf-8'));
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

    session.checkpoints.push({
        checkpointId,
        timestamp: new Date().toISOString(),
        progressPct, filesChanged, summary, qualityScore, warnings,
    });

    await fs.ensureDir(path.join(cwd, '.rigour'));
    await fs.writeFile(checkpointPath, JSON.stringify(session, null, 2));

    await logStudioEvent(cwd, { type: "checkpoint_recorded", requestId, checkpointId, progressPct, qualityScore, warnings });

    let text = `📍 CHECKPOINT RECORDED: ${checkpointId}\n\n`;
    text += `Progress: ${progressPct}% | Quality: ${qualityScore}%\n`;
    text += `Summary: ${summary}\n`;
    text += `Total checkpoints: ${session.checkpoints.length}\n`;
    if (warnings.length > 0) {
        text += `\n⚠️ WARNINGS:\n${warnings.map(w => `  - ${w}`).join('\n')}\n`;
        if (qualityScore < 80) text += `\n⛔ QUALITY BELOW THRESHOLD: Consider pausing and reviewing recent work.`;
    }

    const result: ToolResult = { content: [{ type: "text", text }] };
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
    requestId: string
): Promise<ToolResult> {
    const handoffId = `handoff-${Date.now()}`;
    const handoffPath = path.join(cwd, '.rigour', 'handoffs.jsonl');

    const handoff = {
        handoffId,
        timestamp: new Date().toISOString(),
        fromAgentId, toAgentId, taskDescription, filesInScope, context,
        status: 'pending',
    };

    await fs.ensureDir(path.join(cwd, '.rigour'));
    await fs.appendFile(handoffPath, JSON.stringify(handoff) + '\n');

    await logStudioEvent(cwd, { type: "handoff_initiated", requestId, handoffId, fromAgentId, toAgentId, taskDescription });

    let text = `🤝 HANDOFF INITIATED: ${handoffId}\n\n`;
    text += `From: ${fromAgentId} → To: ${toAgentId}\n`;
    text += `Task: ${taskDescription}\n`;
    if (filesInScope.length > 0) text += `Files in scope: ${filesInScope.join(', ')}\n`;
    if (context) text += `Context: ${context}\n`;
    text += `\nThe receiving agent should call rigour_agent_register to claim this scope.`;

    return { content: [{ type: "text", text }] };
}

// ─── Agent Deregister ─────────────────────────────────────────────

export async function handleAgentDeregister(cwd: string, agentId: string, requestId: string): Promise<ToolResult> {
    const sessionPath = path.join(cwd, '.rigour', 'agent-session.json');

    if (!await fs.pathExists(sessionPath)) {
        return { content: [{ type: "text", text: `❌ No active agent session found.` }] };
    }

    const session = JSON.parse(await fs.readFile(sessionPath, 'utf-8'));
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
    const handoffs = content.trim().split('\n').filter(l => l).map(line => JSON.parse(line));

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
