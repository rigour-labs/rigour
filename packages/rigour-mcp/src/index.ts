#!/usr/bin/env node
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
        version: "1.0.0",
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
                name: "rigour_check",
                description: "Run quality gate checks on the project. Matches the CLI 'check' command.",
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
                name: "rigour_explain",
                description: "Explain the last quality gate failures with actionable bullets. Matches the CLI 'explain' command.",
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
                name: "rigour_status",
                description: "Quick PASS/FAIL check with JSON-friendly output for polling current project state.",
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
                description: "Retrieves a prioritized 'Fix Packet' (v2 schema) containing detailed machine-readable diagnostic data.",
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
                name: "rigour_list_gates",
                description: "Lists all configured quality gates and their thresholds for the current project.",
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
                name: "rigour_get_config",
                description: "Returns the current Rigour configuration (rigour.yml) for agent reasoning.",
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

        switch (name) {
            case "rigour_check": {
                const report = await runner.run(cwd);
                return {
                    content: [
                        {
                            type: "text",
                            text: `RIGOUR AUDIT RESULT: ${report.status}\n\nSummary:\n${Object.entries(report.summary).map(([k, v]) => `- ${k}: ${v}`).join("\n")}`,
                        },
                    ],
                };
            }

            case "rigour_explain": {
                const report = await runner.run(cwd);
                if (report.status === "PASS") {
                    return {
                        content: [
                            {
                                type: "text",
                                text: "ALL QUALITY GATES PASSED. No failures to explain.",
                            },
                        ],
                    };
                }

                const bullets = report.failures.map((f, i) => {
                    return `${i + 1}. [${f.id.toUpperCase()}] ${f.title}: ${f.details}${f.hint ? ` (Hint: ${f.hint})` : ''}`;
                }).join("\n");

                return {
                    content: [
                        {
                            type: "text",
                            text: `RIGOUR EXPLAIN:\n\n${bullets}`,
                        },
                    ],
                };
            }

            case "rigour_status": {
                const report = await runner.run(cwd);
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({
                                status: report.status,
                                summary: report.summary,
                                failureCount: report.failures.length,
                                durationMs: report.stats.duration_ms
                            }, null, 2),
                        },
                    ],
                };
            }

            case "rigour_get_fix_packet": {
                const report = await runner.run(cwd);
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
            }

            case "rigour_list_gates":
                return {
                    content: [
                        {
                            type: "text",
                            text: `ACTIVE QUALITY GATES:\n\n${Object.entries(config.gates).map(([k, v]) => {
                                if (typeof v === 'object' && v !== null) {
                                    return `- ${k}: ${JSON.stringify(v)}`;
                                }
                                return `- ${k}: ${v}`;
                            }).join("\n")}`,
                        },
                    ],
                };

            case "rigour_get_config":
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(config, null, 2),
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
    console.error("Rigour MCP server v1.0.0 running on stdio");
}

main().catch((error) => {
    console.error("Fatal error in Rigour MCP server:", error);
    process.exit(1);
});
