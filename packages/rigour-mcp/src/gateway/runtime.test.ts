import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { DownstreamRegistry, splitGatewayTool } from './runtime.js';

describe('MCP gateway downstream registry', () => {
    it('forwards allowlisted tools and hides all others', async () => {
        const fixture = fileURLToPath(new URL('./fixtures/test-server.mjs', import.meta.url));
        const registry = new DownstreamRegistry({
            version: 1,
            mode: 'observe',
            principalId: 'owner',
            agentId: 'agent-1',
            taskId: 'task-1',
            servers: { fixture: { command: process.execPath, args: [fixture], allow: ['echo'] } },
        }, process.cwd());
        try {
            await registry.connect();
            const tools = await registry.listTools();
            expect(tools.map((tool) => tool.name)).toEqual(['fixture__echo']);
            expect(tools[0].inputSchema.properties).toHaveProperty('_rigourCapability');
            const result = await registry.call('fixture', 'echo', { value: 'hello' });
            expect(result.content).toEqual([{ type: 'text', text: 'hello' }]);
            await expect(registry.call('fixture', 'hidden', {})).rejects.toThrow('not allowed');
        } finally {
            await registry.close();
        }
    });

    it('resolves only configured namespace prefixes', () => {
        expect(splitGatewayTool('github__create_issue', ['github'])).toEqual({ server: 'github', tool: 'create_issue' });
        expect(splitGatewayTool('slack__post_message', ['github'])).toBeNull();
    });
});
