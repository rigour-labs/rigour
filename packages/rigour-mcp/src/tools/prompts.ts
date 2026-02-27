/**
 * MCP Prompt Definitions
 *
 * Reusable prompt templates that guide AI agents through common Rigour workflows.
 * These appear in the MCP prompts capability and can be invoked by any MCP client.
 *
 * @since v3.0.1 — added for Smithery quality compliance
 */

export const PROMPT_DEFINITIONS = [
    {
        name: "rigour-setup",
        description: "Initialize Rigour quality gates for a project. Runs gate checks, installs IDE hooks, and reports the initial quality score breakdown.",
        arguments: [
            {
                name: "cwd",
                description: "Absolute path to the project root.",
                required: false,
            },
        ],
    },
    {
        name: "rigour-fix-loop",
        description: "Iteratively fix all quality gate violations until the project passes. Retrieves fix packets and resolves issues in priority order (critical → low).",
        arguments: [
            {
                name: "cwd",
                description: "Absolute path to the project root.",
                required: false,
            },
        ],
    },
    {
        name: "rigour-security-review",
        description: "Full security review: CVE audit on dependencies + code-level vulnerability scan (OWASP LLM Top 10). Reports all findings with remediation steps.",
        arguments: [
            {
                name: "cwd",
                description: "Absolute path to the project root.",
                required: false,
            },
        ],
    },
    {
        name: "rigour-pre-commit",
        description: "Pre-commit quality gate check. Runs fast hooks on staged files and full gate check. Returns PASS/FAIL verdict for commit safety.",
        arguments: [
            {
                name: "cwd",
                description: "Absolute path to the project root.",
                required: false,
            },
        ],
    },
    {
        name: "rigour-ai-health-report",
        description: "AI code health report focusing on drift detection: hallucinated imports, duplication drift, context window artifacts, inconsistent error handling, and promise safety.",
        arguments: [
            {
                name: "cwd",
                description: "Absolute path to the project root.",
                required: false,
            },
        ],
    },
    {
        name: "rigour-deep-analysis",
        description: "Run deep LLM-powered code quality analysis. AST extracts facts, LLM interprets patterns (SOLID violations, code smells, architecture issues), AST verifies findings. Local sidecar by default; cloud provider mode when configured.",
        arguments: [
            {
                name: "cwd",
                description: "Absolute path to the project root.",
                required: false,
            },
        ],
    },
];
