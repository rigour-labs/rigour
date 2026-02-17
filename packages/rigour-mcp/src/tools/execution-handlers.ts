/**
 * Execution & Supervision Tool Handlers
 *
 * Handlers for: rigour_run, rigour_run_supervised
 *
 * @since v2.17.0 — extracted from monolithic index.ts
 */
import fs from "fs-extra";
import path from "path";
import { GateRunner, Report } from "@rigour-labs/core";
import { logStudioEvent } from '../utils/config.js';

type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };

export async function handleRun(cwd: string, command: string, requestId: string): Promise<ToolResult> {
    // 1. Log Interceptable Event
    await logStudioEvent(cwd, {
        type: "interception_requested",
        requestId,
        tool: "rigour_run",
        command,
    });

    // 2. Poll for Human Arbitration (Max 60s wait)
    console.error(`[RIGOUR] Waiting for human arbitration for command: ${command}`);

    const decision = await pollArbitration(cwd, requestId, 60000);

    if (decision === 'reject') {
        return {
            content: [{ type: "text", text: `❌ COMMAND REJECTED BY GOVERNOR: The execution of "${command}" was blocked by a human operator in the Governance Studio.` }],
            isError: true,
        };
    }

    // Execute
    const { execa } = await import("execa");
    try {
        const { stdout, stderr } = await execa(command, { shell: true, cwd });
        return {
            content: [{ type: "text", text: `✅ COMMAND EXECUTED (Approved by Governor):\n\nSTDOUT:\n${stdout}\n\nSTDERR:\n${stderr}` }],
        };
    } catch (e: any) {
        return {
            content: [{ type: "text", text: `❌ COMMAND FAILED:\n\n${e.message}` }],
            isError: true,
        };
    }
}

export async function handleRunSupervised(
    runner: GateRunner,
    cwd: string,
    command: string,
    maxRetries: number,
    dryRun: boolean,
    requestId: string
): Promise<ToolResult> {
    const { execa } = await import("execa");

    let iteration = 0;
    let lastReport: Report | null = null;
    let result: ToolResult | null = null;
    const iterations: { iteration: number; status: string; failures: number }[] = [];

    await logStudioEvent(cwd, {
        type: "supervisor_started",
        requestId,
        command,
        maxRetries,
        dryRun,
    });

    while (iteration < maxRetries) {
        iteration++;

        if (!dryRun) {
            try {
                await execa(command, { shell: true, cwd });
            } catch (e: any) {
                console.error(`[RIGOUR] Iteration ${iteration} command error: ${e.message}`);
            }
        } else {
            console.error(`[RIGOUR] Iteration ${iteration} (DRY RUN - skipping command execution)`);
        }

        lastReport = await runner.run(cwd);
        iterations.push({ iteration, status: lastReport.status, failures: lastReport.failures.length });

        await logStudioEvent(cwd, {
            type: "supervisor_iteration",
            requestId,
            iteration,
            status: lastReport.status,
            failures: lastReport.failures.length,
        });

        if (lastReport.status === "PASS") {
            result = {
                content: [{
                    type: "text",
                    text: `✅ SUPERVISOR MODE: PASSED on iteration ${iteration}/${maxRetries}\n\nIterations:\n${iterations.map(i => `  ${i.iteration}. ${i.status} (${i.failures} failures)`).join("\n")}\n\nAll quality gates have been satisfied.`,
                }],
            };
            break;
        }

        if (iteration >= maxRetries) {
            const fixPacket = lastReport.failures.map((f, i) => {
                const sevTag = `[${(f.severity || 'medium').toUpperCase()}]`;
                const provTag = f.provenance ? `(${f.provenance})` : '';
                let text = `FIX TASK ${i + 1}: ${sevTag} ${provTag} [${f.id.toUpperCase()}] ${f.title}\n`;
                text += `   - CONTEXT: ${f.details}\n`;
                if (f.files && f.files.length > 0) text += `   - TARGET FILES: ${f.files.join(", ")}\n`;
                if (f.hint) text += `   - REFACTORING GUIDANCE: ${f.hint}\n`;
                return text;
            }).join("\n---\n");

            result = {
                content: [{
                    type: "text",
                    text: `❌ SUPERVISOR MODE: FAILED after ${iteration} iterations\n\nIterations:\n${iterations.map(i => `  ${i.iteration}. ${i.status} (${i.failures} failures)`).join("\n")}\n\nFINAL FIX PACKET:\n${fixPacket}`,
                }],
                isError: true,
            };
        }
    }

    await logStudioEvent(cwd, {
        type: "supervisor_completed",
        requestId,
        finalStatus: lastReport?.status || "UNKNOWN",
        totalIterations: iteration,
    });

    return result!;
}

// ─── Private Helpers ──────────────────────────────────────────────

async function pollArbitration(cwd: string, rid: string, timeout: number): Promise<string | null> {
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
    return "approve"; // Default auto-approve if no human response
}
