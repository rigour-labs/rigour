import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'gateway-test-server', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        { name: 'echo', description: 'Echo input', inputSchema: { type: 'object', properties: { value: { type: 'string' } } } },
        { name: 'hidden', description: 'Not allowed', inputSchema: { type: 'object' } },
    ],
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => ({
    content: [{ type: 'text', text: String(request.params.arguments?.value ?? '') }],
}));
await server.connect(new StdioServerTransport());
