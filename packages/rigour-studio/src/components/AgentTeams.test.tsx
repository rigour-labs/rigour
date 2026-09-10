import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AgentTeams } from './AgentTeams';

describe('AgentTeams', () => {
    it('renders legacy records with missing status and scope without crashing', () => {
        const html = renderToStaticMarkup(<AgentTeams session={{ sessionId: 'legacy', agents: [{ agentId: 'agent-1' }] }} />);
        expect(html).toContain('UNKNOWN');
        expect(html).toContain('Some team data is incomplete');
        expect(html).toContain('agent-1');
    });

    it('renders corrupt payloads as an empty state', () => {
        expect(renderToStaticMarkup(<AgentTeams session={{ agents: 'bad' }} />)).toContain('No Active Agent Team');
    });
});
