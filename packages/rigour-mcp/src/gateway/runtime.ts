import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { GatewayControlConfig, GatewayServerConfig } from '@rigour-labs/core';

export interface GatewayTool extends Tool {
    name: string;
}

interface ConnectedServer {
    client: Client;
    transport: StdioClientTransport;
    config: GatewayServerConfig;
}

function exposedSchema(schema: Tool['inputSchema']): Tool['inputSchema'] {
    const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
    return {
        ...schema,
        properties: {
            ...properties,
            _rigourCapability: {
                type: 'string',
                description: 'One-use capability id issued by the Rigour control plane',
            },
        },
    };
}

export class DownstreamRegistry {
    private readonly connected = new Map<string, ConnectedServer>();

    constructor(private readonly config: GatewayControlConfig, private readonly cwd: string) {}

    async connect(): Promise<void> {
        try {
            for (const [name, serverConfig] of Object.entries(this.config.servers)) {
                const client = new Client({ name: 'rigour-mcp-gateway', version: '1.0.0' });
                const transport = new StdioClientTransport({
                    command: serverConfig.command,
                    args: serverConfig.args,
                    env: { ...getDefaultEnvironment(), ...serverConfig.env },
                    cwd: this.cwd,
                    stderr: 'inherit',
                });
                await client.connect(transport);
                this.connected.set(name, { client, transport, config: serverConfig });
            }
        } catch (error) {
            await this.close();
            throw error;
        }
    }

    async listTools(): Promise<GatewayTool[]> {
        const tools: GatewayTool[] = [];
        for (const [serverName, downstream] of this.connected) {
            const listed = await downstream.client.listTools();
            for (const tool of listed.tools) {
                if (!downstream.config.allow.includes('*') && !downstream.config.allow.includes(tool.name)) continue;
                tools.push({
                    ...tool,
                    name: `${serverName}__${tool.name}`,
                    description: `[via Rigour:${serverName}] ${tool.description ?? tool.name}`,
                    inputSchema: exposedSchema(tool.inputSchema),
                });
            }
        }
        return tools;
    }

    async call(serverName: string, toolName: string, args: Record<string, unknown>): Promise<CallToolResult> {
        const downstream = this.connected.get(serverName);
        if (!downstream) throw new Error(`Unknown downstream MCP server: ${serverName}`);
        if (!downstream.config.allow.includes('*') && !downstream.config.allow.includes(toolName)) {
            throw new Error(`Tool ${serverName}__${toolName} is not allowed by the trusted gateway configuration`);
        }
        return downstream.client.callTool({ name: toolName, arguments: args }) as Promise<CallToolResult>;
    }

    async close(): Promise<void> {
        await Promise.allSettled([...this.connected.values()].map(({ client }) => client.close()));
        this.connected.clear();
    }
}

export function splitGatewayTool(name: string, configuredServers: string[]): { server: string; tool: string } | null {
    const server = configuredServers.find((candidate) => name.startsWith(`${candidate}__`));
    if (!server) return null;
    const tool = name.slice(server.length + 2);
    return tool ? { server, tool } : null;
}
