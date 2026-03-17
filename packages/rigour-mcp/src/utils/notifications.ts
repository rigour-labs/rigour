/**
 * MCP Logging Notifications — Singleton
 *
 * Gives all handler modules access to server.sendLoggingMessage()
 * without threading the server instance through every function signature.
 *
 * Usage:
 *   bindServer(server)          — call once at startup
 *   notifyProgress("info", msg) — fire-and-forget from any handler
 */
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

let _server: Server | null = null;

/** Bind the MCP server instance (call once at startup). */
export function bindServer(server: Server): void {
    _server = server;
}

/**
 * Send a logging notification to the MCP client.
 * Fire-and-forget — silently drops if client doesn't support logging.
 */
export function notifyProgress(
    level: "debug" | "info" | "notice" | "warning" | "error" | "critical",
    message: string,
    logger = "rigour",
): void {
    if (!_server) return;
    try {
        void _server.sendLoggingMessage({ level, logger, data: message });
    } catch {
        // Client may not support logging — graceful fallback
    }
}
