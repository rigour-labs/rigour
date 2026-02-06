import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AgentTeamGate, registerAgent, getSession, clearSession } from './agent-team.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('AgentTeamGate', () => {
    let testDir: string;

    beforeEach(() => {
        testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-team-test-'));
    });

    afterEach(() => {
        clearSession(testDir);
        fs.rmSync(testDir, { recursive: true, force: true });
    });

    describe('gate initialization', () => {
        it('should create gate with default config', () => {
            const gate = new AgentTeamGate();
            expect(gate.id).toBe('agent-team');
            expect(gate.title).toBe('Agent Team Governance');
        });

        it('should skip when not enabled', async () => {
            const gate = new AgentTeamGate({ enabled: false });
            const failures = await gate.run({ cwd: testDir });
            expect(failures).toEqual([]);
        });
    });

    describe('session management', () => {
        it('should register an agent', () => {
            const session = registerAgent(testDir, 'agent-a', ['src/api/**']);
            expect(session.agents).toHaveLength(1);
            expect(session.agents[0].agentId).toBe('agent-a');
            expect(session.agents[0].taskScope).toEqual(['src/api/**']);
        });

        it('should update existing agent registration', () => {
            registerAgent(testDir, 'agent-a', ['src/api/**']);
            const session = registerAgent(testDir, 'agent-a', ['src/api/**', 'src/utils/**']);
            expect(session.agents).toHaveLength(1);
            expect(session.agents[0].taskScope).toEqual(['src/api/**', 'src/utils/**']);
        });

        it('should persist session to disk', () => {
            registerAgent(testDir, 'agent-a', ['src/**']);
            const sessionPath = path.join(testDir, '.rigour', 'agent-session.json');
            expect(fs.existsSync(sessionPath)).toBe(true);
        });

        it('should load session from disk', () => {
            registerAgent(testDir, 'agent-a', ['src/**']);
            // Clear in-memory cache
            clearSession(testDir);
            // Re-register to re-create session file
            registerAgent(testDir, 'agent-b', ['tests/**']);

            const session = getSession(testDir);
            expect(session).not.toBeNull();
            expect(session!.agents).toHaveLength(1); // Only agent-b after clearSession
        });

        it('should clear session', () => {
            registerAgent(testDir, 'agent-a', ['src/**']);
            clearSession(testDir);
            const session = getSession(testDir);
            expect(session).toBeNull();
        });
    });

    describe('max concurrent agents check', () => {
        it('should pass when under limit', async () => {
            const gate = new AgentTeamGate({ enabled: true, max_concurrent_agents: 3 });
            registerAgent(testDir, 'agent-a', ['src/a/**']);
            registerAgent(testDir, 'agent-b', ['src/b/**']);

            const failures = await gate.run({ cwd: testDir });
            expect(failures).toEqual([]);
        });

        it('should fail when over limit', async () => {
            const gate = new AgentTeamGate({ enabled: true, max_concurrent_agents: 2 });
            registerAgent(testDir, 'agent-a', ['src/a/**']);
            registerAgent(testDir, 'agent-b', ['src/b/**']);
            registerAgent(testDir, 'agent-c', ['src/c/**']);

            const failures = await gate.run({ cwd: testDir });
            expect(failures).toHaveLength(1);
            expect(failures[0].title).toBe('Too Many Concurrent Agents');
        });
    });

    describe('task scope conflicts (strict mode)', () => {
        it('should pass when scopes are disjoint', async () => {
            const gate = new AgentTeamGate({
                enabled: true,
                task_ownership: 'strict'
            });
            registerAgent(testDir, 'agent-a', ['src/api/**']);
            registerAgent(testDir, 'agent-b', ['src/ui/**']);

            const failures = await gate.run({ cwd: testDir });
            expect(failures).toEqual([]);
        });

        it('should fail when scopes overlap', async () => {
            const gate = new AgentTeamGate({
                enabled: true,
                task_ownership: 'strict'
            });
            registerAgent(testDir, 'agent-a', ['src/api/**']);
            registerAgent(testDir, 'agent-b', ['src/api/**']); // Same scope!

            const failures = await gate.run({ cwd: testDir });
            expect(failures).toHaveLength(1);
            expect(failures[0].title).toBe('Task Scope Conflict');
        });

        it('should allow overlapping scopes in collaborative mode', async () => {
            const gate = new AgentTeamGate({
                enabled: true,
                task_ownership: 'collaborative'
            });
            registerAgent(testDir, 'agent-a', ['src/api/**']);
            registerAgent(testDir, 'agent-b', ['src/api/**']); // Same scope - OK in collaborative

            const failures = await gate.run({ cwd: testDir });
            expect(failures).toEqual([]);
        });
    });
});
