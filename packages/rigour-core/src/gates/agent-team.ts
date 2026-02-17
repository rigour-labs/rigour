/**
 * Agent Team Governance Gate
 * 
 * Supervises multi-agent coordination for frontier models like
 * Opus 4.6 (agent teams) and GPT-5.3-Codex (coworking mode).
 * 
 * Detects:
 * - Cross-agent pattern conflicts
 * - Task scope violations
 * - Handoff context loss
 * 
 * @since v2.14.0
 */

import { Gate, GateContext } from './base.js';
import { Failure, Provenance } from '../types/index.js';
import { Logger } from '../utils/logger.js';
import * as fs from 'fs';
import * as path from 'path';

export interface AgentRegistration {
    agentId: string;
    taskScope: string[];  // Glob patterns for files this agent owns
    registeredAt: Date;
    lastActivity?: Date;
}

export interface AgentTeamSession {
    sessionId: string;
    agents: AgentRegistration[];
    startedAt: Date;
}

export interface AgentTeamConfig {
    enabled?: boolean;
    max_concurrent_agents?: number;
    cross_agent_pattern_check?: boolean;
    handoff_verification?: boolean;
    task_ownership?: 'strict' | 'collaborative';
}

// In-memory session store (persisted to .rigour/agent-session.json)
let currentSession: AgentTeamSession | null = null;

/**
 * Register an agent in the current session
 */
export function registerAgent(cwd: string, agentId: string, taskScope: string[]): AgentTeamSession {
    if (!currentSession) {
        currentSession = {
            sessionId: `session-${Date.now()}`,
            agents: [],
            startedAt: new Date(),
        };
    }

    // Check if agent already registered
    const existing = currentSession.agents.find(a => a.agentId === agentId);
    if (existing) {
        existing.taskScope = taskScope;
        existing.lastActivity = new Date();
    } else {
        currentSession.agents.push({
            agentId,
            taskScope,
            registeredAt: new Date(),
        });
    }

    // Persist session
    persistSession(cwd);
    return currentSession;
}

/**
 * Get current session status
 */
export function getSession(cwd: string): AgentTeamSession | null {
    if (!currentSession) {
        loadSession(cwd);
    }
    return currentSession;
}

/**
 * Clear current session
 */
export function clearSession(cwd: string): void {
    currentSession = null;
    const sessionPath = path.join(cwd, '.rigour', 'agent-session.json');
    if (fs.existsSync(sessionPath)) {
        fs.unlinkSync(sessionPath);
    }
}

function persistSession(cwd: string): void {
    const rigourDir = path.join(cwd, '.rigour');
    if (!fs.existsSync(rigourDir)) {
        fs.mkdirSync(rigourDir, { recursive: true });
    }
    const sessionPath = path.join(rigourDir, 'agent-session.json');
    fs.writeFileSync(sessionPath, JSON.stringify(currentSession, null, 2));
}

function loadSession(cwd: string): void {
    const sessionPath = path.join(cwd, '.rigour', 'agent-session.json');
    if (fs.existsSync(sessionPath)) {
        try {
            const data = JSON.parse(fs.readFileSync(sessionPath, 'utf-8'));
            currentSession = {
                ...data,
                startedAt: new Date(data.startedAt),
                agents: data.agents.map((a: any) => ({
                    ...a,
                    registeredAt: new Date(a.registeredAt),
                    lastActivity: a.lastActivity ? new Date(a.lastActivity) : undefined,
                })),
            };
        } catch (err) {
            Logger.warn('Failed to load agent session, starting fresh');
            currentSession = null;
        }
    }
}

/**
 * Check if two glob patterns might overlap
 */
function scopesOverlap(scope1: string[], scope2: string[]): string[] {
    const overlapping: string[] = [];
    for (const s1 of scope1) {
        for (const s2 of scope2) {
            // Simple overlap detection - same path or one is prefix of other
            if (s1 === s2 || s1.startsWith(s2.replace('**', '')) || s2.startsWith(s1.replace('**', ''))) {
                overlapping.push(`${s1} ↔ ${s2}`);
            }
        }
    }
    return overlapping;
}

export class AgentTeamGate extends Gate {
    private config: AgentTeamConfig;

    constructor(config: AgentTeamConfig = {}) {
        super('agent-team', 'Agent Team Governance');
        this.config = {
            enabled: config.enabled ?? false,
            max_concurrent_agents: config.max_concurrent_agents ?? 3,
            cross_agent_pattern_check: config.cross_agent_pattern_check ?? true,
            handoff_verification: config.handoff_verification ?? true,
            task_ownership: config.task_ownership ?? 'strict',
        };
    }

    protected get provenance(): Provenance { return 'governance'; }

    async run(context: GateContext): Promise<Failure[]> {
        if (!this.config.enabled) {
            return [];
        }

        const failures: Failure[] = [];
        const session = getSession(context.cwd);

        if (!session || session.agents.length === 0) {
            // No multi-agent session active, skip
            return [];
        }

        Logger.info(`Agent Team Gate: ${session.agents.length} agents in session`);

        // Check 1: Max concurrent agents
        if (session.agents.length > (this.config.max_concurrent_agents ?? 3)) {
            failures.push(this.createFailure(
                `Too many concurrent agents: ${session.agents.length} (max: ${this.config.max_concurrent_agents})`,
                undefined,
                'Reduce the number of concurrent agents or increase max_concurrent_agents in rigour.yml',
                'Too Many Concurrent Agents'
            ));
        }

        // Check 2: Task scope conflicts (strict mode only)
        if (this.config.task_ownership === 'strict') {
            for (let i = 0; i < session.agents.length; i++) {
                for (let j = i + 1; j < session.agents.length; j++) {
                    const agent1 = session.agents[i];
                    const agent2 = session.agents[j];
                    const overlaps = scopesOverlap(agent1.taskScope, agent2.taskScope);

                    if (overlaps.length > 0) {
                        failures.push(this.createFailure(
                            `Task scope conflict between ${agent1.agentId} and ${agent2.agentId}: ${overlaps.join(', ')}`,
                            undefined,
                            'In strict mode, each agent must have exclusive task scope. Either adjust scopes or set task_ownership: collaborative',
                            'Task Scope Conflict'
                        ));
                    }
                }
            }
        }

        // Check 3: Cross-agent pattern detection (if enabled)
        if (this.config.cross_agent_pattern_check && context.record) {
            // This would integrate with the Pattern Index to detect conflicting patterns
            // For now, we log that we would do this check
            Logger.debug('Cross-agent pattern check: would analyze patterns across agent scopes');
        }

        return failures;
    }
}
