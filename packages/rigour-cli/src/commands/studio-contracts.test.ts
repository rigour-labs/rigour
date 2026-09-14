import { describe, expect, it } from 'vitest';
import { normalizeAgentSession, resolveStudioVersion } from './studio-contracts.js';

describe('resolveStudioVersion', () => {
    it('prefers the released CLI version used to serve Studio', () => {
        expect(resolveStudioVersion('6.2.1', '5.4.0')).toBe('6.2.1');
        expect(resolveStudioVersion(undefined, '6.2.0')).toBe('6.2.0');
    });
});

describe('normalizeAgentSession', () => {
    it('repairs a legacy session without status', () => {
        const session = normalizeAgentSession({
            sessionId: 'legacy',
            agents: [{ agentId: 'agent-1', taskScope: ['src/**'], registeredAt: '2026-09-10T00:00:00Z' }],
        }, '2026-09-10T01:00:00.000Z');

        expect(session.status).toBe('idle');
        expect(session.agents[0].status).toBe('idle');
        expect(session.dataQuality).toBe('degraded');
        expect(session.warnings).toContain('Session status was inferred from agent activity.');
    });

    it('returns an inactive contract for malformed input', () => {
        expect(normalizeAgentSession({ agents: 'broken' }).status).toBe('inactive');
        expect(normalizeAgentSession(null).agents).toEqual([]);
    });

    it('preserves valid current sessions', () => {
        const session = normalizeAgentSession({
            sessionId: 'session-1',
            status: 'active',
            createdAt: '2026-09-10T00:00:00Z',
            agents: [{
                agentId: 'agent-1',
                taskScope: ['src/**'],
                registeredAt: '2026-09-10T00:00:00Z',
                status: 'active',
            }],
        });

        expect(session.dataQuality).toBe('valid');
        expect(session.status).toBe('active');
    });
});
