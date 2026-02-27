/**
 * MCP Tool Definitions
 *
 * Schema definitions for all Rigour MCP tools.
 * Each tool has a name, description, JSON Schema for input, and MCP annotations.
 *
 * Annotations follow the MCP spec (2025-03-26):
 *   title         — human-readable display name
 *   readOnlyHint  — true if tool only reads/computes, never writes
 *   destructiveHint — true if tool deletes or overwrites data
 *   idempotentHint  — true if repeated calls produce same result
 *   openWorldHint   — true if tool reaches outside the user's project
 *
 * @since v2.17.0 — extracted from monolithic index.ts
 * @since v3.0.0 — hooks tools added
 * @since v3.0.1 — MCP annotations added for Smithery quality compliance
 */

function cwdParam() {
    return {
        cwd: {
            type: "string" as const,
            description: "Absolute path to the project root.",
        },
    };
}

export const TOOL_DEFINITIONS = [
    // ─── Core Quality Gates ───────────────────────────────
    {
        name: "rigour_check",
        description: "Run quality gate checks on the project. Deep modes: off (fast deterministic gates only), quick (deep enabled with standard local tier unless cloud provider is configured), full (deep enabled, optional pro model).",
        inputSchema: {
            type: "object",
            properties: {
                ...cwdParam(),
                files: { type: "array", items: { type: "string" }, description: "Optional file paths (relative to cwd) to limit scan scope for both deterministic and deep checks." },
                deep: { type: "string", enum: ["off", "quick", "full"], description: "Deep mode: 'off' (default), 'quick' (deep enabled with standard model), 'full' (deep enabled, combine with pro=true for larger local model)." },
                pro: { type: "boolean", description: "Use larger local deep model tier when deep is enabled." },
                apiKey: { type: "string", description: "Optional cloud API key for deep analysis." },
                provider: { type: "string", description: "Cloud provider for deep analysis (claude, openai, gemini, groq, mistral, together, deepseek, ollama, etc.)." },
                apiBaseUrl: { type: "string", description: "Custom API base URL for self-hosted/proxy deep endpoints." },
                modelName: { type: "string", description: "Override cloud model name for deep analysis." },
            },
            required: ["cwd"],
        },
        annotations: {
            title: "Run Quality Gates",
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        },
    },
    {
        name: "rigour_explain",
        description: "Explain the last quality gate failures with actionable bullets. Matches the CLI 'explain' command.",
        inputSchema: {
            type: "object",
            properties: cwdParam(),
            required: ["cwd"],
        },
        annotations: {
            title: "Explain Gate Failures",
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        },
    },
    {
        name: "rigour_status",
        description: "Quick PASS/FAIL check with JSON-friendly output for polling current project state.",
        inputSchema: {
            type: "object",
            properties: cwdParam(),
            required: ["cwd"],
        },
        annotations: {
            title: "Quality Status",
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        },
    },
    {
        name: "rigour_get_fix_packet",
        description: "Retrieves a prioritized 'Fix Packet' (v2 schema) containing detailed machine-readable diagnostic data.",
        inputSchema: {
            type: "object",
            properties: cwdParam(),
            required: ["cwd"],
        },
        annotations: {
            title: "Get Fix Packet",
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        },
    },
    {
        name: "rigour_list_gates",
        description: "Lists all configured quality gates and their thresholds for the current project.",
        inputSchema: {
            type: "object",
            properties: cwdParam(),
            required: ["cwd"],
        },
        annotations: {
            title: "List Quality Gates",
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        },
    },
    {
        name: "rigour_get_config",
        description: "Returns the current Rigour configuration (rigour.yml) for agent reasoning.",
        inputSchema: {
            type: "object",
            properties: cwdParam(),
            required: ["cwd"],
        },
        annotations: {
            title: "Get Configuration",
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        },
    },
    {
        name: "rigour_mcp_get_settings",
        description: "Get Rigour MCP runtime settings for this repository (.rigour/mcp-settings.json).",
        inputSchema: {
            type: "object",
            properties: cwdParam(),
            required: ["cwd"],
        },
        annotations: {
            title: "Get MCP Settings",
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        },
    },
    {
        name: "rigour_mcp_set_settings",
        description: "Set Rigour MCP runtime settings for this repository. Currently supports deep_default_mode: off | quick | full.",
        inputSchema: {
            type: "object",
            properties: {
                ...cwdParam(),
                deep_default_mode: {
                    type: "string",
                    enum: ["off", "quick", "full"],
                    description: "Default deep mode applied to rigour_check when deep is not passed.",
                },
            },
            required: ["cwd", "deep_default_mode"],
        },
        annotations: {
            title: "Set MCP Settings",
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        },
    },

    // ─── Memory Persistence ───────────────────────────────
    {
        name: "rigour_remember",
        description: "Store a persistent instruction or context that the AI should remember across sessions. Use this to persist user preferences, project conventions, or critical instructions.",
        inputSchema: {
            type: "object",
            properties: {
                ...cwdParam(),
                key: { type: "string", description: "A unique key for this memory (e.g., 'user_preferences', 'coding_style')." },
                value: { type: "string", description: "The instruction or context to remember." },
            },
            required: ["cwd", "key", "value"],
        },
        annotations: {
            title: "Store Memory",
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        },
    },
    {
        name: "rigour_recall",
        description: "Retrieve stored instructions or context. Call this at the start of each session to restore memory. Returns all stored memories if no key specified.",
        inputSchema: {
            type: "object",
            properties: {
                ...cwdParam(),
                key: { type: "string", description: "Optional. Key of specific memory to retrieve." },
            },
            required: ["cwd"],
        },
        annotations: {
            title: "Recall Memory",
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        },
    },
    {
        name: "rigour_forget",
        description: "Remove a stored memory by key.",
        inputSchema: {
            type: "object",
            properties: {
                ...cwdParam(),
                key: { type: "string", description: "Key of the memory to remove." },
            },
            required: ["cwd", "key"],
        },
        annotations: {
            title: "Delete Memory",
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: true,
            openWorldHint: false,
        },
    },

    // ─── Pattern Intelligence ─────────────────────────────
    {
        name: "rigour_check_pattern",
        description: "Checks if a proposed code pattern (function, component, etc.) already exists, is stale, or has security vulnerabilities (CVEs). CALL THIS BEFORE CREATING NEW CODE.",
        inputSchema: {
            type: "object",
            properties: {
                ...cwdParam(),
                name: { type: "string", description: "The name of the function, class, or component you want to create." },
                type: { type: "string", description: "The type of pattern (e.g., 'function', 'component', 'hook', 'type')." },
                intent: { type: "string", description: "What the code is for (e.g., 'format dates', 'user authentication')." },
            },
            required: ["cwd", "name"],
        },
        annotations: {
            title: "Check Pattern Exists",
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        },
    },
    {
        name: "rigour_security_audit",
        description: "Runs a live security audit (CVE check) on the project dependencies.",
        inputSchema: {
            type: "object",
            properties: cwdParam(),
            required: ["cwd"],
        },
        annotations: {
            title: "Security Audit",
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
        },
    },

    // ─── Execution & Supervision ──────────────────────────
    {
        name: "rigour_run",
        description: "Execute a command under Rigour supervision. This tool can be INTERCEPTED and ARBITRATED by the Governance Studio.",
        inputSchema: {
            type: "object",
            properties: {
                ...cwdParam(),
                command: { type: "string", description: "The command to run (e.g., 'npm test', 'pytest')." },
                silent: { type: "boolean", description: "If true, hides the command output from the agent." },
            },
            required: ["cwd", "command"],
        },
        annotations: {
            title: "Run Command",
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: false,
        },
    },
    {
        name: "rigour_run_supervised",
        description: "Run a command under FULL Supervisor Mode. Iteratively executes the command, checks quality gates, and returns fix packets until PASS or max retries reached. Use this for self-healing agent loops.",
        inputSchema: {
            type: "object",
            properties: {
                ...cwdParam(),
                command: { type: "string", description: "The agent command to run (e.g., 'claude \"fix the bug\"', 'aider --message \"refactor auth\"')." },
                maxRetries: { type: "number", description: "Maximum retry iterations (default: 3)." },
                dryRun: { type: "boolean", description: "If true, simulates the loop without executing the command. Useful for testing gate checks." },
            },
            required: ["cwd", "command"],
        },
        annotations: {
            title: "Supervised Execution",
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: false,
        },
    },

    // ─── Multi-Agent Governance (v2.14+) ──────────────────
    {
        name: "rigour_agent_register",
        description: "Register an agent in a multi-agent session. Use this at the START of agent execution to claim task scope and enable cross-agent conflict detection. Required for Agent Team Governance.",
        inputSchema: {
            type: "object",
            properties: {
                ...cwdParam(),
                agentId: { type: "string", description: "Unique identifier for this agent (e.g., 'agent-a', 'opus-frontend')." },
                taskScope: { type: "array", items: { type: "string" }, description: "Glob patterns defining the files/directories this agent will work on (e.g., ['src/api/**', 'tests/api/**'])." },
            },
            required: ["cwd", "agentId", "taskScope"],
        },
        annotations: {
            title: "Register Agent",
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        },
    },
    {
        name: "rigour_checkpoint",
        description: "Record a quality checkpoint during long-running agent execution. Use periodically (every 15-30 min) to enable drift detection and quality monitoring. Essential for GPT-5.3 coworking mode.",
        inputSchema: {
            type: "object",
            properties: {
                ...cwdParam(),
                progressPct: { type: "number", description: "Estimated progress percentage (0-100)." },
                filesChanged: { type: "array", items: { type: "string" }, description: "List of files modified since last checkpoint." },
                summary: { type: "string", description: "Brief description of work done since last checkpoint." },
                qualityScore: { type: "number", description: "Self-assessed quality score (0-100). Be honest - artificially high scores trigger drift detection." },
            },
            required: ["cwd", "progressPct", "summary", "qualityScore"],
        },
        annotations: {
            title: "Record Checkpoint",
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: false,
        },
    },
    {
        name: "rigour_handoff",
        description: "Handoff task to another agent in a multi-agent workflow. Use when delegating a subtask or completing your scope. Enables verified handoff governance.",
        inputSchema: {
            type: "object",
            properties: {
                ...cwdParam(),
                fromAgentId: { type: "string", description: "ID of the agent initiating the handoff." },
                toAgentId: { type: "string", description: "ID of the agent receiving the handoff." },
                taskDescription: { type: "string", description: "Description of the task being handed off." },
                filesInScope: { type: "array", items: { type: "string" }, description: "Files relevant to the handoff." },
                context: { type: "string", description: "Additional context for the receiving agent." },
            },
            required: ["cwd", "fromAgentId", "toAgentId", "taskDescription"],
        },
        annotations: {
            title: "Handoff Task",
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: false,
        },
    },
    {
        name: "rigour_agent_deregister",
        description: "Deregister an agent from the multi-agent session. Use when an agent completes its work or needs to release its scope for another agent.",
        inputSchema: {
            type: "object",
            properties: {
                ...cwdParam(),
                agentId: { type: "string", description: "ID of the agent to deregister." },
            },
            required: ["cwd", "agentId"],
        },
        annotations: {
            title: "Deregister Agent",
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: true,
            openWorldHint: false,
        },
    },
    {
        name: "rigour_handoff_accept",
        description: "Accept a pending handoff from another agent. Use to formally acknowledge receipt of a task and verify you are the intended recipient.",
        inputSchema: {
            type: "object",
            properties: {
                ...cwdParam(),
                handoffId: { type: "string", description: "ID of the handoff to accept." },
                agentId: { type: "string", description: "ID of the accepting agent (must match toAgentId in the handoff)." },
            },
            required: ["cwd", "handoffId", "agentId"],
        },
        annotations: {
            title: "Accept Handoff",
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        },
    },

    // ─── Real-Time Hooks (v3.0) ────────────────────────────
    {
        name: "rigour_hooks_check",
        description: "Run the fast hook checker on specific files. Same checks that run inside IDE hooks (Claude, Cursor, Cline, Windsurf). Catches: hardcoded secrets, hallucinated imports, command injection, file size. Completes in <100ms.",
        inputSchema: {
            type: "object",
            properties: {
                ...cwdParam(),
                files: { type: "array", items: { type: "string" }, description: "List of file paths (relative to cwd) to check." },
                timeout: { type: "number", description: "Optional timeout in milliseconds (default: 5000)." },
            },
            required: ["cwd", "files"],
        },
        annotations: {
            title: "Fast Hook Check",
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        },
    },
    {
        name: "rigour_hooks_init",
        description: "Generate hook configs for AI coding tools (Claude, Cursor, Cline, Windsurf). Installs real-time quality checks that run on every file write.",
        inputSchema: {
            type: "object",
            properties: {
                ...cwdParam(),
                tool: { type: "string", description: "Target tool: 'claude', 'cursor', 'cline', or 'windsurf'." },
                force: { type: "boolean", description: "Overwrite existing hook files (default: false)." },
                dryRun: { type: "boolean", description: "Preview changes without writing files (default: false)." },
            },
            required: ["cwd", "tool"],
        },
        annotations: {
            title: "Install IDE Hooks",
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        },
    },

    // ─── Deep Analysis (v4.0+) ──────────────────────────────
    {
        name: "rigour_check_deep",
        description: "Run quality gates WITH deep LLM-powered analysis. Three-step pipeline: AST extracts facts → LLM interprets → AST verifies. Local-first by default (Qwen2.5-Coder), or bring your own API key for any cloud provider.",
        inputSchema: {
            type: "object",
            properties: {
                ...cwdParam(),
                pro: { type: "boolean", description: "Use the larger 1.5B model (--pro tier). Default: false (0.5B model)." },
                apiKey: { type: "string", description: "API key for cloud LLM provider. If provided, uses cloud instead of local sidecar." },
                provider: { type: "string", description: "Cloud provider name (e.g., 'claude', 'openai', 'gemini', 'groq', 'mistral', 'together', 'fireworks', 'deepseek', 'perplexity', 'ollama', 'lmstudio'). Default: 'claude' when apiKey is provided." },
                apiBaseUrl: { type: "string", description: "Custom API base URL for self-hosted or proxy endpoints." },
                modelName: { type: "string", description: "Override the default model name for the chosen provider." },
            },
            required: ["cwd"],
        },
        annotations: {
            title: "Deep Analysis",
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        },
    },
    {
        name: "rigour_deep_stats",
        description: "Get deep analysis statistics from SQLite storage. Returns recent scan scores, top issues, and score trends for a repository.",
        inputSchema: {
            type: "object",
            properties: {
                ...cwdParam(),
                limit: { type: "number", description: "Number of recent scans to return (default: 10)." },
            },
            required: ["cwd"],
        },
        annotations: {
            title: "Deep Analysis Stats",
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        },
    },

    // ─── Code Review ──────────────────────────────────────
    {
        name: "rigour_review",
        description: "Perform a high-fidelity code review on a pull request diff. Analyzes changed files using all active quality gates.",
        inputSchema: {
            type: "object",
            properties: {
                ...cwdParam(),
                repository: { type: "string", description: "Full repository name (e.g., 'owner/repo')." },
                branch: { type: "string", description: "The branch containing the changes." },
                diff: { type: "string", description: "The git diff content to analyze." },
                files: { type: "array", items: { type: "string" }, description: "List of filenames that were changed." },
            },
            required: ["cwd", "diff"],
        },
        annotations: {
            title: "Code Review",
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        },
    },
];
