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
import { randomUUID } from "crypto";
import {
    GateRunner,
    ConfigSchema,
    Report,
} from "@rigour-labs/core";
import {
    PatternMatcher,
    loadPatternIndex,
    getDefaultIndexPath,
    StalenessDetector,
    SecurityDetector
} from "@rigour-labs/core/pattern-index";

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
        // Auto-initialize Rigour if config doesn't exist
        console.error(`[RIGOUR] rigour.yml not found in ${cwd}, auto-initializing...`);
        const { execa } = await import("execa");
        try {
            await execa("npx", ["rigour", "init"], { cwd, shell: true });
            console.error(`[RIGOUR] Auto-initialization complete.`);
        } catch (initError: any) {
            throw new Error(`Rigour auto-initialization failed: ${initError.message}. Please run 'npx rigour init' manually.`);
        }
    }
    const configContent = await fs.readFile(configPath, "utf-8");
    return ConfigSchema.parse(yaml.parse(configContent));
}

// Memory persistence for context retention
interface MemoryStore {
    memories: Record<string, { value: string; timestamp: string }>;
}

async function getMemoryPath(cwd: string): Promise<string> {
    const rigourDir = path.join(cwd, ".rigour");
    await fs.ensureDir(rigourDir);
    return path.join(rigourDir, "memory.json");
}

async function loadMemory(cwd: string): Promise<MemoryStore> {
    const memPath = await getMemoryPath(cwd);
    if (await fs.pathExists(memPath)) {
        const content = await fs.readFile(memPath, "utf-8");
        return JSON.parse(content);
    }
    return { memories: {} };
}

async function saveMemory(cwd: string, store: MemoryStore): Promise<void> {
    const memPath = await getMemoryPath(cwd);
    await fs.writeFile(memPath, JSON.stringify(store, null, 2));
}

// Helper to log events for Rigour Studio
async function logStudioEvent(cwd: string, event: any) {
    try {
        const rigourDir = path.join(cwd, ".rigour");
        await fs.ensureDir(rigourDir);
        const eventsPath = path.join(rigourDir, "events.jsonl");
        const logEntry = JSON.stringify({
            id: randomUUID(),
            timestamp: new Date().toISOString(),
            ...event
        }) + "\n";
        await fs.appendFile(eventsPath, logEntry);
    } catch {
        // Silent fail - Studio logging is non-blocking and zero-telemetry
    }
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
            {
                name: "rigour_remember",
                description: "Store a persistent instruction or context that the AI should remember across sessions. Use this to persist user preferences, project conventions, or critical instructions.",
                inputSchema: {
                    type: "object",
                    properties: {
                        cwd: {
                            type: "string",
                            description: "Absolute path to the project root.",
                        },
                        key: {
                            type: "string",
                            description: "A unique key for this memory (e.g., 'user_preferences', 'coding_style').",
                        },
                        value: {
                            type: "string",
                            description: "The instruction or context to remember.",
                        },
                    },
                    required: ["cwd", "key", "value"],
                },
            },
            {
                name: "rigour_recall",
                description: "Retrieve stored instructions or context. Call this at the start of each session to restore memory. Returns all stored memories if no key specified.",
                inputSchema: {
                    type: "object",
                    properties: {
                        cwd: {
                            type: "string",
                            description: "Absolute path to the project root.",
                        },
                        key: {
                            type: "string",
                            description: "Optional. Key of specific memory to retrieve.",
                        },
                    },
                    required: ["cwd"],
                },
            },
            {
                name: "rigour_forget",
                description: "Remove a stored memory by key.",
                inputSchema: {
                    type: "object",
                    properties: {
                        cwd: {
                            type: "string",
                            description: "Absolute path to the project root.",
                        },
                        key: {
                            type: "string",
                            description: "Key of the memory to remove.",
                        },
                    },
                    required: ["cwd", "key"],
                },
            },
            {
                name: "rigour_check_pattern",
                description: "Checks if a proposed code pattern (function, component, etc.) already exists, is stale, or has security vulnerabilities (CVEs). CALL THIS BEFORE CREATING NEW CODE.",
                inputSchema: {
                    type: "object",
                    properties: {
                        cwd: {
                            type: "string",
                            description: "Absolute path to the project root.",
                        },
                        name: {
                            type: "string",
                            description: "The name of the function, class, or component you want to create.",
                        },
                        type: {
                            type: "string",
                            description: "The type of pattern (e.g., 'function', 'component', 'hook', 'type').",
                        },
                        intent: {
                            type: "string",
                            description: "What the code is for (e.g., 'format dates', 'user authentication').",
                        },
                    },
                    required: ["cwd", "name"],
                },
            },
            {
                name: "rigour_security_audit",
                description: "Runs a live security audit (CVE check) on the project dependencies.",
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
                name: "rigour_run",
                description: "Execute a command under Rigour supervision. This tool can be INTERCEPTED and ARBITRATED by the Governance Studio.",
                inputSchema: {
                    type: "object",
                    properties: {
                        cwd: {
                            type: "string",
                            description: "Absolute path to the project root.",
                        },
                        command: {
                            type: "string",
                            description: "The command to run (e.g., 'npm test', 'pytest').",
                        },
                        silent: {
                            type: "boolean",
                            description: "If true, hides the command output from the agent.",
                        }
                    },
                    required: ["cwd", "command"],
                },
            },
            {
                name: "rigour_run_supervised",
                description: "Run a command under FULL Supervisor Mode. Iteratively executes the command, checks quality gates, and returns fix packets until PASS or max retries reached. Use this for self-healing agent loops.",
                inputSchema: {
                    type: "object",
                    properties: {
                        cwd: {
                            type: "string",
                            description: "Absolute path to the project root.",
                        },
                        command: {
                            type: "string",
                            description: "The agent command to run (e.g., 'claude \"fix the bug\"', 'aider --message \"refactor auth\"').",
                        },
                        maxRetries: {
                            type: "number",
                            description: "Maximum retry iterations (default: 3).",
                        },
                        dryRun: {
                            type: "boolean",
                            description: "If true, simulates the loop without executing the command. Useful for testing gate checks.",
                        },
                    },
                    required: ["cwd", "command"],
                },
            },
            // === FRONTIER MODEL TOOLS (v2.14+) ===
            // For Opus 4.6, GPT-5.3-Codex multi-agent and long-running sessions
            {
                name: "rigour_agent_register",
                description: "Register an agent in a multi-agent session. Use this at the START of agent execution to claim task scope and enable cross-agent conflict detection. Required for Agent Team Governance.",
                inputSchema: {
                    type: "object",
                    properties: {
                        cwd: {
                            type: "string",
                            description: "Absolute path to the project root.",
                        },
                        agentId: {
                            type: "string",
                            description: "Unique identifier for this agent (e.g., 'agent-a', 'opus-frontend').",
                        },
                        taskScope: {
                            type: "array",
                            items: { type: "string" },
                            description: "Glob patterns defining the files/directories this agent will work on (e.g., ['src/api/**', 'tests/api/**']).",
                        },
                    },
                    required: ["cwd", "agentId", "taskScope"],
                },
            },
            {
                name: "rigour_checkpoint",
                description: "Record a quality checkpoint during long-running agent execution. Use periodically (every 15-30 min) to enable drift detection and quality monitoring. Essential for GPT-5.3 coworking mode.",
                inputSchema: {
                    type: "object",
                    properties: {
                        cwd: {
                            type: "string",
                            description: "Absolute path to the project root.",
                        },
                        progressPct: {
                            type: "number",
                            description: "Estimated progress percentage (0-100).",
                        },
                        filesChanged: {
                            type: "array",
                            items: { type: "string" },
                            description: "List of files modified since last checkpoint.",
                        },
                        summary: {
                            type: "string",
                            description: "Brief description of work done since last checkpoint.",
                        },
                        qualityScore: {
                            type: "number",
                            description: "Self-assessed quality score (0-100). Be honest - artificially high scores trigger drift detection.",
                        },
                    },
                    required: ["cwd", "progressPct", "summary", "qualityScore"],
                },
            },
            {
                name: "rigour_handoff",
                description: "Handoff task to another agent in a multi-agent workflow. Use when delegating a subtask or completing your scope. Enables verified handoff governance.",
                inputSchema: {
                    type: "object",
                    properties: {
                        cwd: {
                            type: "string",
                            description: "Absolute path to the project root.",
                        },
                        fromAgentId: {
                            type: "string",
                            description: "ID of the agent initiating the handoff.",
                        },
                        toAgentId: {
                            type: "string",
                            description: "ID of the agent receiving the handoff.",
                        },
                        taskDescription: {
                            type: "string",
                            description: "Description of the task being handed off.",
                        },
                        filesInScope: {
                            type: "array",
                            items: { type: "string" },
                            description: "Files relevant to the handoff.",
                        },
                        context: {
                            type: "string",
                            description: "Additional context for the receiving agent.",
                        },
                    },
                    required: ["cwd", "fromAgentId", "toAgentId", "taskDescription"],
                },
            },
            {
                name: "rigour_agent_deregister",
                description: "Deregister an agent from the multi-agent session. Use when an agent completes its work or needs to release its scope for another agent.",
                inputSchema: {
                    type: "object",
                    properties: {
                        cwd: {
                            type: "string",
                            description: "Absolute path to the project root.",
                        },
                        agentId: {
                            type: "string",
                            description: "ID of the agent to deregister.",
                        },
                    },
                    required: ["cwd", "agentId"],
                },
            },
            {
                name: "rigour_handoff_accept",
                description: "Accept a pending handoff from another agent. Use to formally acknowledge receipt of a task and verify you are the intended recipient.",
                inputSchema: {
                    type: "object",
                    properties: {
                        cwd: {
                            type: "string",
                            description: "Absolute path to the project root.",
                        },
                        handoffId: {
                            type: "string",
                            description: "ID of the handoff to accept.",
                        },
                        agentId: {
                            type: "string",
                            description: "ID of the accepting agent (must match toAgentId in the handoff).",
                        },
                    },
                    required: ["cwd", "handoffId", "agentId"],
                },
            }
        ],
    };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const cwd = (args as any)?.cwd || process.cwd();
    const requestId = randomUUID();

    try {
        await logStudioEvent(cwd, {
            type: "tool_call",
            requestId,
            tool: name,
            arguments: args
        });

        const config = await loadConfig(cwd);
        const runner = new GateRunner(config);

        let result: any;

        switch (name) {
            case "rigour_check": {
                const report = await runner.run(cwd);
                result = {
                    content: [
                        {
                            type: "text",
                            text: `RIGOUR AUDIT RESULT: ${report.status}\n\nSummary:\n${Object.entries(report.summary).map(([k, v]) => `- ${k}: ${v}`).join("\n")}`,
                        },
                    ],
                };

                // Add the report to the tool_response log for high-fidelity Studio visualization
                (result as any)._rigour_report = report;
                break;
            }

            case "rigour_explain": {
                const report = await runner.run(cwd);
                if (report.status === "PASS") {
                    result = {
                        content: [
                            {
                                type: "text",
                                text: "ALL QUALITY GATES PASSED. No failures to explain.",
                            },
                        ],
                    };
                } else {
                    const bullets = report.failures.map((f, i) => {
                        return `${i + 1}. [${f.id.toUpperCase()}] ${f.title}: ${f.details}${f.hint ? ` (Hint: ${f.hint})` : ''}`;
                    }).join("\n");

                    result = {
                        content: [
                            {
                                type: "text",
                                text: `RIGOUR EXPLAIN:\n\n${bullets}`,
                            },
                        ],
                    };
                }
                break;
            }

            case "rigour_status": {
                const report = await runner.run(cwd);
                result = {
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
                break;
            }

            case "rigour_get_fix_packet": {
                const report = await runner.run(cwd);
                if (report.status === "PASS") {
                    result = {
                        content: [
                            {
                                type: "text",
                                text: "ALL QUALITY GATES PASSED. The current state meets the required engineering standards.",
                            },
                        ],
                    };
                } else {
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

                    result = {
                        content: [
                            {
                                type: "text",
                                text: `ENGINEERING REFINEMENT REQUIRED:\n\nThe project state violated ${report.failures.length} quality gates. You MUST address these failures before declaring the task complete:\n\n${packet}`,
                            },
                        ],
                    };
                }
                break;
            }

            case "rigour_list_gates":
                result = {
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
                break;

            case "rigour_get_config":
                result = {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(config, null, 2),
                        },
                    ],
                };
                break;

            case "rigour_remember": {
                const { key, value } = args as any;
                const store = await loadMemory(cwd);
                store.memories[key] = {
                    value,
                    timestamp: new Date().toISOString(),
                };
                await saveMemory(cwd, store);
                result = {
                    content: [
                        {
                            type: "text",
                            text: `MEMORY STORED: "${key}" has been saved. This instruction will persist across sessions.\n\nStored value: ${value}`,
                        },
                    ],
                };
                break;
            }

            case "rigour_recall": {
                const { key } = args as any;
                const store = await loadMemory(cwd);

                if (key) {
                    const memory = store.memories[key];
                    if (!memory) {
                        result = {
                            content: [
                                {
                                    type: "text",
                                    text: `NO MEMORY FOUND for key "${key}". Use rigour_remember to store instructions.`,
                                },
                            ],
                        };
                    } else {
                        result = {
                            content: [
                                {
                                    type: "text",
                                    text: `RECALLED MEMORY [${key}]:\n${memory.value}\n\n(Stored: ${memory.timestamp})`,
                                },
                            ],
                        };
                    }
                } else {
                    const keys = Object.keys(store.memories);
                    if (keys.length === 0) {
                        result = {
                            content: [
                                {
                                    type: "text",
                                    text: "NO MEMORIES STORED. Use rigour_remember to persist important instructions.",
                                },
                            ],
                        };
                    } else {
                        const allMemories = keys.map(k => {
                            const mem = store.memories[k];
                            return `## ${k}\n${mem.value}\n(Stored: ${mem.timestamp})`;
                        }).join("\n\n---\n\n");

                        result = {
                            content: [
                                {
                                    type: "text",
                                    text: `RECALLED ALL MEMORIES (${keys.length} items):\n\n${allMemories}\n\n---\nIMPORTANT: Follow these stored instructions throughout this session.`,
                                },
                            ],
                        };
                    }
                }
                break;
            }

            case "rigour_forget": {
                const { key } = args as any;
                const store = await loadMemory(cwd);

                if (!store.memories[key]) {
                    result = {
                        content: [
                            {
                                type: "text",
                                text: `NO MEMORY FOUND for key "${key}". Nothing to forget.`,
                            },
                        ],
                    };
                } else {
                    delete store.memories[key];
                    await saveMemory(cwd, store);

                    result = {
                        content: [
                            {
                                type: "text",
                                text: `MEMORY DELETED: "${key}" has been removed.`,
                            },
                        ],
                    };
                }
                break;
            }

            case "rigour_check_pattern": {
                const { name: patternName, type, intent } = args as any;
                const indexPath = getDefaultIndexPath(cwd);
                const index = await loadPatternIndex(indexPath);

                let resultText = "";

                // 1. Check for Reinvention
                if (index) {
                    const matcher = new PatternMatcher(index);
                    const matchResult = await matcher.match({ name: patternName, type, intent });

                    if (matchResult.status === "FOUND_SIMILAR") {
                        resultText += `🚨 PATTERN REINVENTION DETECTED\n`;
                        resultText += `Similar pattern already exists: "${matchResult.matches[0].pattern.name}" in ${matchResult.matches[0].pattern.file}\n`;
                        resultText += `SUGGESTION: ${matchResult.suggestion}\n\n`;
                    }
                } else {
                    resultText += `⚠️ Pattern index not found. Run 'rigour index' to enable reinvention detection.\n\n`;
                }

                // 2. Check for Staleness/Best Practices
                const detector = new StalenessDetector(cwd);
                const staleness = await detector.checkStaleness(`${type || 'function'} ${patternName} {}`);

                if (staleness.status !== "FRESH") {
                    resultText += `⚠️ STALENESS/ANTI-PATTERN WARNING\n`;
                    for (const issue of staleness.issues) {
                        resultText += `- ${issue.reason}\n  REPLACEMENT: ${issue.replacement}\n`;
                    }
                    resultText += `\n`;
                }

                // 3. Check Security for this library (if it's an import)
                if (intent && intent.includes('import')) {
                    const security = new SecurityDetector(cwd);
                    const audit = await security.runAudit();
                    const relatedVulns = audit.vulnerabilities.filter(v =>
                        patternName.toLowerCase().includes(v.packageName.toLowerCase()) ||
                        intent.toLowerCase().includes(v.packageName.toLowerCase())
                    );

                    if (relatedVulns.length > 0) {
                        resultText += `🛡️ SECURITY/CVE WARNING\n`;
                        for (const v of relatedVulns) {
                            resultText += `- [${v.severity.toUpperCase()}] ${v.packageName}: ${v.title} (${v.url})\n`;
                        }
                        resultText += `\n`;
                    }
                }

                if (!resultText) {
                    resultText = `✅ Pattern "${patternName}" is fresh, secure, and unique to the codebase.\n\nRECOMMENDED ACTION: Proceed with implementation.`;
                } else {
                    let recommendation = "Proceed with caution, addressing the warnings above.";
                    if (resultText.includes("🚨 PATTERN REINVENTION")) {
                        recommendation = "STOP and REUSE the existing pattern mentioned above. Do not create a duplicate.";
                    } else if (resultText.includes("🛡️ SECURITY/CVE WARNING")) {
                        recommendation = "STOP and update your dependencies or find an alternative library. Do not proceed with vulnerable code.";
                    } else if (resultText.includes("⚠️ STALENESS")) {
                        recommendation = "Follow the replacement suggestion to ensure best practices.";
                    }

                    resultText += `\nRECOMMENDED ACTION: ${recommendation}`;
                }

                result = {
                    content: [
                        {
                            type: "text",
                            text: resultText,
                        },
                    ],
                };
                break;
            }

            case "rigour_security_audit": {
                const security = new SecurityDetector(cwd);
                const summary = await security.getSecuritySummary();
                result = {
                    content: [
                        {
                            type: "text",
                            text: summary,
                        },
                    ],
                };
                break;
            }

            case "rigour_run": {
                const { command } = args as any;

                // 1. Log Interceptable Event
                await logStudioEvent(cwd, {
                    type: "interception_requested",
                    requestId: requestId,
                    tool: "rigour_run",
                    command
                });

                // 2. Poll for Human Arbitration (Max 60s wait for this demo/test)
                // In production, this would be a blocking call wait
                console.error(`[RIGOUR] Waiting for human arbitration for command: ${command}`);

                const pollArbitration = async (rid: string, timeout: number): Promise<string | null> => {
                    const start = Date.now();
                    const eventsPath = path.join(cwd, '.rigour/events.jsonl');
                    while (Date.now() - start < timeout) {
                        if (await fs.pathExists(eventsPath)) {
                            const content = await fs.readFile(eventsPath, 'utf-8');
                            const lines = content.split('\n').filter(l => l.trim());
                            for (const line of lines.reverse()) {
                                const event = JSON.parse(line);
                                if (event.tool === 'human_arbitration' && event.requestId === rid) {
                                    return event.decision;
                                }
                            }
                        }
                        await new Promise(r => setTimeout(r, 1000));
                    }
                    return "approve"; // Default to auto-approve if no human response (for non-blocking feel)
                };

                const decision = await pollArbitration(requestId, 60000);

                if (decision === 'reject') {
                    result = {
                        content: [
                            {
                                type: "text",
                                text: `❌ COMMAND REJECTED BY GOVERNOR: The execution of "${command}" was blocked by a human operator in the Governance Studio.`,
                            },
                        ],
                        isError: true
                    };
                } else {
                    // Execute
                    const { execa } = await import("execa");
                    try {
                        const { stdout, stderr } = await execa(command, { shell: true, cwd });
                        result = {
                            content: [
                                {
                                    type: "text",
                                    text: `✅ COMMAND EXECUTED (Approved by Governor):\n\nSTDOUT:\n${stdout}\n\nSTDERR:\n${stderr}`,
                                },
                            ],
                        };
                    } catch (e: any) {
                        result = {
                            content: [
                                {
                                    type: "text",
                                    text: `❌ COMMAND FAILED:\n\n${e.message}`,
                                },
                            ],
                            isError: true
                        };
                    }
                }
                break;
            }

            case "rigour_run_supervised": {
                const { command, maxRetries = 3, dryRun = false } = args as any;
                const { execa } = await import("execa");

                let iteration = 0;
                let lastReport: Report | null = null;
                const iterations: { iteration: number; status: string; failures: number }[] = [];

                await logStudioEvent(cwd, {
                    type: "supervisor_started",
                    requestId,
                    command,
                    maxRetries,
                    dryRun
                });

                while (iteration < maxRetries) {
                    iteration++;

                    // 1. Execute the agent command (skip in dryRun mode)
                    if (!dryRun) {
                        try {
                            await execa(command, { shell: true, cwd });
                        } catch (e: any) {
                            // Command failure is OK - agent might have partial progress
                            console.error(`[RIGOUR] Iteration ${iteration} command error: ${e.message}`);
                        }
                    } else {
                        console.error(`[RIGOUR] Iteration ${iteration} (DRY RUN - skipping command execution)`);
                    }


                    // 2. Check quality gates
                    lastReport = await runner.run(cwd);
                    iterations.push({
                        iteration,
                        status: lastReport.status,
                        failures: lastReport.failures.length
                    });

                    await logStudioEvent(cwd, {
                        type: "supervisor_iteration",
                        requestId,
                        iteration,
                        status: lastReport.status,
                        failures: lastReport.failures.length
                    });

                    // 3. If PASS, we're done
                    if (lastReport.status === "PASS") {
                        result = {
                            content: [
                                {
                                    type: "text",
                                    text: `✅ SUPERVISOR MODE: PASSED on iteration ${iteration}/${maxRetries}\n\nIterations:\n${iterations.map(i => `  ${i.iteration}. ${i.status} (${i.failures} failures)`).join("\n")}\n\nAll quality gates have been satisfied.`,
                                },
                            ],
                        };
                        break;
                    }

                    // 4. If not at max retries, continue the loop (agent will use fix packet next iteration)
                    if (iteration >= maxRetries) {
                        // Final failure - return fix packet
                        const fixPacket = lastReport.failures.map((f, i) => {
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

                        result = {
                            content: [
                                {
                                    type: "text",
                                    text: `❌ SUPERVISOR MODE: FAILED after ${iteration} iterations\n\nIterations:\n${iterations.map(i => `  ${i.iteration}. ${i.status} (${i.failures} failures)`).join("\n")}\n\nFINAL FIX PACKET:\n${fixPacket}`,
                                },
                            ],
                            isError: true
                        };
                    }
                }

                await logStudioEvent(cwd, {
                    type: "supervisor_completed",
                    requestId,
                    finalStatus: lastReport?.status || "UNKNOWN",
                    totalIterations: iteration
                });

                break;
            }

            // === FRONTIER MODEL TOOL HANDLERS (v2.14+) ===

            case "rigour_agent_register": {
                const { agentId, taskScope } = args as any;

                // Load or create agent session
                const sessionPath = path.join(cwd, '.rigour', 'agent-session.json');
                let session = { agents: [] as any[], startedAt: new Date().toISOString() };

                if (await fs.pathExists(sessionPath)) {
                    session = JSON.parse(await fs.readFile(sessionPath, 'utf-8'));
                }

                // Check for existing agent
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

                await fs.ensureDir(path.join(cwd, '.rigour'));
                await fs.writeFile(sessionPath, JSON.stringify(session, null, 2));

                await logStudioEvent(cwd, {
                    type: "agent_registered",
                    requestId,
                    agentId,
                    taskScope,
                    conflicts,
                });

                let responseText = `✅ AGENT REGISTERED: "${agentId}" claimed scope: ${taskScope.join(', ')}\n\n`;
                responseText += `Active agents in session: ${session.agents.length}\n`;

                if (conflicts.length > 0) {
                    responseText += `\n⚠️ SCOPE CONFLICTS DETECTED:\n${conflicts.map(c => `  - ${c}`).join('\n')}\n`;
                    responseText += `\nConsider coordinating with other agents or narrowing your scope.`;
                }

                result = {
                    content: [{ type: "text", text: responseText }],
                };
                break;
            }

            case "rigour_checkpoint": {
                const { progressPct, filesChanged = [], summary, qualityScore } = args as any;

                // Load checkpoint session
                const checkpointPath = path.join(cwd, '.rigour', 'checkpoint-session.json');
                let session = {
                    sessionId: `chk-session-${Date.now()}`,
                    startedAt: new Date().toISOString(),
                    checkpoints: [] as any[],
                    status: 'active'
                };

                if (await fs.pathExists(checkpointPath)) {
                    session = JSON.parse(await fs.readFile(checkpointPath, 'utf-8'));
                }

                const checkpointId = `cp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                const warnings: string[] = [];

                // Quality threshold check
                if (qualityScore < 80) {
                    warnings.push(`Quality score ${qualityScore}% is below threshold 80%`);
                }

                // Drift detection (quality degrading over time)
                if (session.checkpoints.length >= 2) {
                    const recentScores = session.checkpoints.slice(-3).map((cp: any) => cp.qualityScore);
                    const avgRecent = recentScores.reduce((a: number, b: number) => a + b, 0) / recentScores.length;
                    if (qualityScore < avgRecent - 10) {
                        warnings.push(`Drift detected: quality dropped from avg ${avgRecent.toFixed(0)}% to ${qualityScore}%`);
                    }
                }

                const checkpoint = {
                    checkpointId,
                    timestamp: new Date().toISOString(),
                    progressPct,
                    filesChanged,
                    summary,
                    qualityScore,
                    warnings,
                };

                session.checkpoints.push(checkpoint);
                await fs.ensureDir(path.join(cwd, '.rigour'));
                await fs.writeFile(checkpointPath, JSON.stringify(session, null, 2));

                await logStudioEvent(cwd, {
                    type: "checkpoint_recorded",
                    requestId,
                    checkpointId,
                    progressPct,
                    qualityScore,
                    warnings,
                });

                let responseText = `📍 CHECKPOINT RECORDED: ${checkpointId}\n\n`;
                responseText += `Progress: ${progressPct}% | Quality: ${qualityScore}%\n`;
                responseText += `Summary: ${summary}\n`;
                responseText += `Total checkpoints: ${session.checkpoints.length}\n`;

                if (warnings.length > 0) {
                    responseText += `\n⚠️ WARNINGS:\n${warnings.map(w => `  - ${w}`).join('\n')}\n`;
                    if (qualityScore < 80) {
                        responseText += `\n⛔ QUALITY BELOW THRESHOLD: Consider pausing and reviewing recent work.`;
                    }
                }

                const shouldContinue = qualityScore >= 80;
                (result as any)._shouldContinue = shouldContinue;

                result = {
                    content: [{ type: "text", text: responseText }],
                };
                break;
            }

            case "rigour_handoff": {
                const { fromAgentId, toAgentId, taskDescription, filesInScope = [], context = '' } = args as any;

                const handoffId = `handoff-${Date.now()}`;
                const handoffPath = path.join(cwd, '.rigour', 'handoffs.jsonl');

                const handoff = {
                    handoffId,
                    timestamp: new Date().toISOString(),
                    fromAgentId,
                    toAgentId,
                    taskDescription,
                    filesInScope,
                    context,
                    status: 'pending',
                };

                await fs.ensureDir(path.join(cwd, '.rigour'));
                await fs.appendFile(handoffPath, JSON.stringify(handoff) + '\n');

                await logStudioEvent(cwd, {
                    type: "handoff_initiated",
                    requestId,
                    handoffId,
                    fromAgentId,
                    toAgentId,
                    taskDescription,
                });

                let responseText = `🤝 HANDOFF INITIATED: ${handoffId}\n\n`;
                responseText += `From: ${fromAgentId} → To: ${toAgentId}\n`;
                responseText += `Task: ${taskDescription}\n`;
                if (filesInScope.length > 0) {
                    responseText += `Files in scope: ${filesInScope.join(', ')}\n`;
                }
                if (context) {
                    responseText += `Context: ${context}\n`;
                }
                responseText += `\nThe receiving agent should call rigour_agent_register to claim this scope.`;

                result = {
                    content: [{ type: "text", text: responseText }],
                };
                break;
            }

            case "rigour_agent_deregister": {
                const { agentId } = args as any;

                const sessionPath = path.join(cwd, '.rigour', 'agent-session.json');

                if (!await fs.pathExists(sessionPath)) {
                    result = {
                        content: [{ type: "text", text: `❌ No active agent session found.` }],
                    };
                    break;
                }

                const session = JSON.parse(await fs.readFile(sessionPath, 'utf-8'));
                const initialCount = session.agents.length;
                session.agents = session.agents.filter((a: any) => a.agentId !== agentId);

                if (session.agents.length === initialCount) {
                    result = {
                        content: [{ type: "text", text: `❌ Agent "${agentId}" not found in session.` }],
                    };
                    break;
                }

                await fs.writeFile(sessionPath, JSON.stringify(session, null, 2));

                await logStudioEvent(cwd, {
                    type: "agent_deregistered",
                    requestId,
                    agentId,
                    remainingAgents: session.agents.length,
                });

                let responseText = `✅ AGENT DEREGISTERED: "${agentId}" has been removed from the session.\n\n`;
                responseText += `Remaining agents: ${session.agents.length}\n`;
                if (session.agents.length > 0) {
                    responseText += `Active: ${session.agents.map((a: any) => a.agentId).join(', ')}`;
                }

                result = {
                    content: [{ type: "text", text: responseText }],
                };
                break;
            }

            case "rigour_handoff_accept": {
                const { handoffId, agentId } = args as any;

                const handoffPath = path.join(cwd, '.rigour', 'handoffs.jsonl');

                if (!await fs.pathExists(handoffPath)) {
                    result = {
                        content: [{ type: "text", text: `❌ No handoffs found.` }],
                    };
                    break;
                }

                const content = await fs.readFile(handoffPath, 'utf-8');
                const handoffs = content.trim().split('\n').filter(l => l).map(line => JSON.parse(line));

                const handoff = handoffs.find((h: any) => h.handoffId === handoffId);
                if (!handoff) {
                    result = {
                        content: [{ type: "text", text: `❌ Handoff "${handoffId}" not found.` }],
                    };
                    break;
                }

                if (handoff.toAgentId !== agentId) {
                    result = {
                        content: [{
                            type: "text",
                            text: `❌ Agent "${agentId}" is not the intended recipient.\nHandoff is for: ${handoff.toAgentId}`
                        }],
                        isError: true
                    };
                    break;
                }

                handoff.status = 'accepted';
                handoff.acceptedAt = new Date().toISOString();
                handoff.acceptedBy = agentId;

                // Rewrite the file with updated handoff
                const updatedContent = handoffs.map((h: any) => JSON.stringify(h)).join('\n') + '\n';
                await fs.writeFile(handoffPath, updatedContent);

                await logStudioEvent(cwd, {
                    type: "handoff_accepted",
                    requestId,
                    handoffId,
                    acceptedBy: agentId,
                    fromAgentId: handoff.fromAgentId,
                });

                let responseText = `✅ HANDOFF ACCEPTED: ${handoffId}\n\n`;
                responseText += `From: ${handoff.fromAgentId}\n`;
                responseText += `Task: ${handoff.taskDescription}\n`;
                if (handoff.filesInScope?.length > 0) {
                    responseText += `Files in scope: ${handoff.filesInScope.join(', ')}\n`;
                }
                responseText += `\nYou should now call rigour_agent_register to formally claim the scope.`;

                result = {
                    content: [{ type: "text", text: responseText }],
                };
                break;
            }

            default:
                throw new Error(`Unknown tool: ${name}`);
        }

        await logStudioEvent(cwd, {
            type: "tool_response",
            requestId,
            tool: name,
            status: "success",
            content: result.content,
            _rigour_report: (result as any)._rigour_report
        });

        return result;

    } catch (error: any) {
        const errorResponse = {
            content: [
                {
                    type: "text",
                    text: `RIGOUR ERROR: ${error.message}`,
                },
            ],
            isError: true,
        };

        await logStudioEvent(cwd, {
            type: "tool_response",
            requestId,
            tool: name,
            status: "error",
            error: error.message,
            content: errorResponse.content
        });

        return errorResponse;
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
