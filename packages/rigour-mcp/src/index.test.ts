import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';

// Mock the MCP tool handlers for testing
// In a real scenario, we'd refactor index.ts to export testable functions

describe('MCP Frontier Tools', () => {
    let testDir: string;
    let rigourDir: string;

    beforeEach(async () => {
        testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-test-'));
        rigourDir = path.join(testDir, '.rigour');
        await fs.ensureDir(rigourDir);
    });

    afterEach(async () => {
        await fs.remove(testDir);
    });

    describe('rigour_agent_register', () => {
        const sessionPath = () => path.join(rigourDir, 'agent-session.json');

        async function registerAgent(agentId: string, taskScope: string[]) {
            let session = { agents: [] as any[], startedAt: new Date().toISOString() };

            if (await fs.pathExists(sessionPath())) {
                session = JSON.parse(await fs.readFile(sessionPath(), 'utf-8'));
            }

            const existingIdx = session.agents.findIndex((a: any) => a.agentId === agentId);
            if (existingIdx >= 0) {
                session.agents[existingIdx] = {
                    agentId,
                    taskScope,
                    registeredAt: session.agents[existingIdx].registeredAt,
                    lastCheckpoint: new Date().toISOString(),
                };
            } else {
                session.agents.push({
                    agentId,
                    taskScope,
                    registeredAt: new Date().toISOString(),
                    lastCheckpoint: new Date().toISOString(),
                });
            }

            // Check for scope conflicts
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

            await fs.writeFile(sessionPath(), JSON.stringify(session, null, 2));
            return { session, conflicts };
        }

        it('should register a new agent', async () => {
            const { session, conflicts } = await registerAgent('agent-a', ['src/api/**']);

            expect(session.agents).toHaveLength(1);
            expect(session.agents[0].agentId).toBe('agent-a');
            expect(conflicts).toHaveLength(0);
        });

        it('should detect scope conflicts', async () => {
            await registerAgent('agent-a', ['src/api/**', 'src/utils/**']);
            const { conflicts } = await registerAgent('agent-b', ['src/api/**']);

            expect(conflicts).toHaveLength(1);
            expect(conflicts[0]).toContain('agent-a');
        });

        it('should update existing agent registration', async () => {
            await registerAgent('agent-a', ['src/api/**']);
            const { session } = await registerAgent('agent-a', ['src/api/**', 'tests/**']);

            expect(session.agents).toHaveLength(1);
            expect(session.agents[0].taskScope).toContain('tests/**');
        });

        it('should support multiple agents', async () => {
            await registerAgent('agent-a', ['src/frontend/**']);
            await registerAgent('agent-b', ['src/backend/**']);
            const { session } = await registerAgent('agent-c', ['src/shared/**']);

            expect(session.agents).toHaveLength(3);
        });
    });

    describe('rigour_checkpoint', () => {
        const checkpointPath = () => path.join(rigourDir, 'checkpoint-session.json');

        async function recordCheckpoint(progressPct: number, qualityScore: number, summary = 'Test') {
            let session = {
                sessionId: `chk-session-${Date.now()}`,
                startedAt: new Date().toISOString(),
                checkpoints: [] as any[],
                status: 'active'
            };

            if (await fs.pathExists(checkpointPath())) {
                session = JSON.parse(await fs.readFile(checkpointPath(), 'utf-8'));
            }

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

            const checkpoint = {
                checkpointId: `cp-${Date.now()}`,
                timestamp: new Date().toISOString(),
                progressPct,
                summary,
                qualityScore,
                warnings,
            };

            session.checkpoints.push(checkpoint);
            await fs.writeFile(checkpointPath(), JSON.stringify(session, null, 2));

            return { checkpoint, warnings, session };
        }

        it('should record a checkpoint', async () => {
            const { checkpoint, session } = await recordCheckpoint(25, 85, 'Initial work');

            expect(checkpoint.progressPct).toBe(25);
            expect(checkpoint.qualityScore).toBe(85);
            expect(session.checkpoints).toHaveLength(1);
        });

        it('should warn on low quality score', async () => {
            const { warnings } = await recordCheckpoint(50, 65, 'Struggling');

            expect(warnings.some(w => w.includes('below threshold'))).toBe(true);
        });

        it('should detect quality drift', async () => {
            await recordCheckpoint(20, 90);
            await recordCheckpoint(40, 88);
            await recordCheckpoint(60, 85);
            const { warnings } = await recordCheckpoint(80, 70);

            expect(warnings.some(w => w.includes('Drift detected'))).toBe(true);
        });

        it('should track multiple checkpoints', async () => {
            await recordCheckpoint(25, 90);
            await recordCheckpoint(50, 88);
            await recordCheckpoint(75, 92);
            const { session } = await recordCheckpoint(100, 95);

            expect(session.checkpoints).toHaveLength(4);
        });
    });

    describe('rigour_handoff', () => {
        const handoffPath = () => path.join(rigourDir, 'handoffs.jsonl');

        async function createHandoff(
            fromAgentId: string,
            toAgentId: string,
            taskDescription: string,
            filesInScope: string[] = []
        ) {
            const handoff = {
                handoffId: `handoff-${Date.now()}`,
                timestamp: new Date().toISOString(),
                fromAgentId,
                toAgentId,
                taskDescription,
                filesInScope,
                status: 'pending',
            };

            await fs.appendFile(handoffPath(), JSON.stringify(handoff) + '\n');
            return handoff;
        }

        it('should create a handoff record', async () => {
            const handoff = await createHandoff('agent-a', 'agent-b', 'Complete API integration');

            expect(handoff.fromAgentId).toBe('agent-a');
            expect(handoff.toAgentId).toBe('agent-b');
            expect(handoff.status).toBe('pending');
        });

        it('should include files in scope', async () => {
            const handoff = await createHandoff(
                'agent-a',
                'agent-b',
                'Fix tests',
                ['tests/api.test.ts', 'tests/utils.test.ts']
            );

            expect(handoff.filesInScope).toHaveLength(2);
        });

        it('should append multiple handoffs', async () => {
            await createHandoff('agent-a', 'agent-b', 'Task 1');
            await createHandoff('agent-b', 'agent-c', 'Task 2');

            const content = await fs.readFile(handoffPath(), 'utf-8');
            const lines = content.trim().split('\n');

            expect(lines).toHaveLength(2);
        });
    });

    describe('rigour_agent_deregister', () => {
        const sessionPath = () => path.join(rigourDir, 'agent-session.json');

        async function deregisterAgent(agentId: string) {
            if (!await fs.pathExists(sessionPath())) {
                return { success: false, message: 'No active session' };
            }

            const session = JSON.parse(await fs.readFile(sessionPath(), 'utf-8'));
            const initialCount = session.agents.length;
            session.agents = session.agents.filter((a: any) => a.agentId !== agentId);

            await fs.writeFile(sessionPath(), JSON.stringify(session, null, 2));

            return {
                success: session.agents.length < initialCount,
                remainingAgents: session.agents.length,
            };
        }

        it('should remove an agent from session', async () => {
            // First register
            const session = { agents: [{ agentId: 'agent-a', taskScope: [] }], startedAt: new Date().toISOString() };
            await fs.writeFile(sessionPath(), JSON.stringify(session));

            const result = await deregisterAgent('agent-a');

            expect(result.success).toBe(true);
            expect(result.remainingAgents).toBe(0);
        });

        it('should handle non-existent agent', async () => {
            const session = { agents: [{ agentId: 'agent-a', taskScope: [] }], startedAt: new Date().toISOString() };
            await fs.writeFile(sessionPath(), JSON.stringify(session));

            const result = await deregisterAgent('agent-b');

            expect(result.success).toBe(false);
        });
    });

    describe('rigour_handoff_accept', () => {
        const handoffPath = () => path.join(rigourDir, 'handoffs.jsonl');

        async function acceptHandoff(handoffId: string, agentId: string) {
            if (!await fs.pathExists(handoffPath())) {
                return { success: false, message: 'No handoffs found' };
            }

            const content = await fs.readFile(handoffPath(), 'utf-8');
            const handoffs = content.trim().split('\n').map(line => JSON.parse(line));

            const handoff = handoffs.find(h => h.handoffId === handoffId);
            if (!handoff) {
                return { success: false, message: 'Handoff not found' };
            }

            if (handoff.toAgentId !== agentId) {
                return { success: false, message: 'Agent not the intended recipient' };
            }

            handoff.status = 'accepted';
            handoff.acceptedAt = new Date().toISOString();

            // Rewrite the file with updated handoff
            const updatedContent = handoffs.map(h => JSON.stringify(h)).join('\n') + '\n';
            await fs.writeFile(handoffPath(), updatedContent);

            return { success: true, handoff };
        }

        it('should accept a pending handoff', async () => {
            const handoff = {
                handoffId: 'handoff-123',
                fromAgentId: 'agent-a',
                toAgentId: 'agent-b',
                taskDescription: 'Test task',
                status: 'pending',
            };
            await fs.writeFile(handoffPath(), JSON.stringify(handoff) + '\n');

            const result = await acceptHandoff('handoff-123', 'agent-b');

            expect(result.success).toBe(true);
            expect(result.handoff?.status).toBe('accepted');
        });

        it('should reject if agent is not recipient', async () => {
            const handoff = {
                handoffId: 'handoff-123',
                fromAgentId: 'agent-a',
                toAgentId: 'agent-b',
                taskDescription: 'Test task',
                status: 'pending',
            };
            await fs.writeFile(handoffPath(), JSON.stringify(handoff) + '\n');

            const result = await acceptHandoff('handoff-123', 'agent-c');

            expect(result.success).toBe(false);
            expect(result.message).toContain('not the intended recipient');
        });
    });
});
