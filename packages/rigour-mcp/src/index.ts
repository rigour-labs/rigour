import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "fs-extra";
import path from "path";
import yaml from "yaml";
import { GateRunner, ConfigSchema, Report } from "@rigour-labs/core";

const server = new Server(
    {
        name: "rigour-mcp",
        version: "0.1.1",
    },
    {
        capabilities: {
            tools: {},
        },
    }
);

async function loadConfig(cwd: string) {
    const configPath = path.join(cwd, "rigour.yml");
    if (!(await fs.pathExists(configPath))) {
        throw new Error("Rigour configuration (rigour.yml) not found. The agent must run `rigour init` first to establish engineering standards.");
    }
    const configContent = await fs.readFile(configPath, "utf-8");
    return ConfigSchema.parse(yaml.parse(configContent));
}

server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: "rigour_check_status",
                description: "Checks the current project state against Rigour engineering gates. Returns PASS/FAIL and a summary of active gates.",
                inputSchema: {
                    type: "object",
                    properties: {
                        cwd: {
                            type: "string",
                            description: "Absolute path to the project root.",
                        },
                    },
                    required: ["cwd"],
                },
            },
            {
                name: "rigour_get_fix_packet",
                description: "Retrieves a prioritized 'Fix Packet' containing actionable engineering instructions to resolve quality gate failures. Use this to iteratively improve your solution.",
                inputSchema: {
                    type: "object",
                    properties: {
                        cwd: {
                            type: "string",
                            description: "Absolute path to the project root.",
                        },
                    },
                    required: ["cwd"],
                },
            },
        ],
    };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const cwd = (args as any)?.cwd || process.cwd();

    try {
        const config = await loadConfig(cwd);
        const runner = new GateRunner(config);
        const report = await runner.run(cwd);

        switch (name) {
            case "rigour_check_status":
                return {
                    content: [
                        {
                            type: "text",
                            text: `RIGOUR AUDIT RESULT: ${report.status}\n\nSummary:\n${Object.entries(report.summary).map(([k, v]) => `- ${k}: ${v}`).join("\n")}`,
                        },
                    ],
                };

            case "rigour_get_fix_packet":
                if (report.status === "PASS") {
                    return {
                        content: [
                            {
                                type: "text",
                                text: "ALL QUALITY GATES PASSED. The current state meets the required engineering standards.",
                            },
                        ],
                    };
                }

                const packet = report.failures.map((f, i) => {
                    let text = `FIX TASK ${i + 1}: [${f.id.toUpperCase()}] ${f.title}\n`;
                    text += `   - CONTEXT: ${f.details}\n`;
                    if (f.files && f.files.length > 0) {
                        text += `   - TARGET FILES: ${f.files.join(", ")}\n`;
                    }
                    if (f.hint) {
                        text += `   - REFACTORING GUIDANCE: ${f.hint}\n`;
                    }
                    return text;
                }).join("\n---\n");

                return {
                    content: [
                        {
                            type: "text",
                            text: `ENGINEERING REFINEMENT REQUIRED:\n\nThe project state violated ${report.failures.length} quality gates. You MUST address these failures before declaring the task complete:\n\n${packet}`,
                        },
                    ],
                };

            default:
                throw new Error(`Unknown tool: ${name}`);
        }
    } catch (error: any) {
        return {
            content: [
                {
                    type: "text",
                    text: `RIGOUR ERROR: ${error.message}`,
                },
            ],
            isError: true,
        };
    }
});

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Rigour MCP server v0.1.1 running on stdio");
}

main().catch((error) => {
    console.error("Fatal error in Rigour MCP server:", error);
    process.exit(1);
});
