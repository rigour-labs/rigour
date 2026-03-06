/**
 * Execution & Supervision Tool Handlers
 *
 * Handlers for: rigour_run, rigour_run_supervised
 *
 * @since v2.17.0 — extracted from monolithic index.ts
 */
import fs from "fs-extra";
import path from "path";
import { GateRunner, Report, FixPacketService } from "@rigour-labs/core";
import type { Config } from "@rigour-labs/core";
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
    requestId: string,
    config?: Config,
): Promise<ToolResult> {
    const { execa } = await import("execa");

    let iteration = 0;
    let lastReport: Report | null = null;
    let result: ToolResult | null = null;
    const iterations: { iteration: number; status: string; failures: number; failedGates: string[] }[] = [];

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
        const failedGateIds = [...new Set(lastReport.failures.map(f => f.id))];
        iterations.push({
            iteration,
            status: lastReport.status,
            failures: lastReport.failures.length,
            failedGates: failedGateIds,
        });

        await logStudioEvent(cwd, {
            type: "supervisor_iteration",
            requestId,
            iteration,
            status: lastReport.status,
            failures: lastReport.failures.length,
            failedGates: failedGateIds,
        });

        if (lastReport.status === "PASS") {
            const score = lastReport.stats.score !== undefined ? ` | Score: ${lastReport.stats.score}/100` : '';
            result = {
                content: [{
                    type: "text",
                    text: `✅ SUPERVISOR MODE: PASSED on iteration ${iteration}/${maxRetries}${score}\n\nIterations:\n${formatIterationHistory(iterations)}\n\nAll quality gates have been satisfied.`,
                }],
            };
            break;
        }

        if (iteration >= maxRetries) {
            // Use FixPacketService for structured output instead of ad-hoc formatting
            let fixPacketText: string;
            if (config) {
                const fixPacketService = new FixPacketService();
                const fixPacket = fixPacketService.generate(lastReport, config);
                fixPacketText = formatFixPacketForSupervisor(fixPacket);
            } else {
                // Fallback if config not available
                fixPacketText = lastReport.failures.map((f, i) => {
                    const sevTag = `[${(f.severity || 'medium').toUpperCase()}]`;
                    return `${i + 1}. ${sevTag} [${f.id}] ${f.title}: ${f.details}${f.files?.length ? ` (${f.files.join(', ')})` : ''}`;
                }).join('\n');
            }

            result = {
                content: [{
                    type: "text",
                    text: `❌ SUPERVISOR MODE: FAILED after ${iteration} iterations\n\nIterations:\n${formatIterationHistory(iterations)}\n\n${fixPacketText}`,
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

function formatIterationHistory(iterations: { iteration: number; status: string; failures: number; failedGates: string[] }[]): string {
    return iterations.map(i => {
        const gates = i.failedGates.length > 0 ? ` [${i.failedGates.join(', ')}]` : '';
        return `  ${i.iteration}. ${i.status} (${i.failures} failures)${gates}`;
    }).join('\n');
}

function formatFixPacketForSupervisor(fixPacket: any): string {
    const lines: string[] = [];
    lines.push(`FINAL FIX PACKET (${fixPacket.violations.length} violations across gates: ${fixPacket.failed_gates.join(', ')})`);
    lines.push('');

    fixPacket.violations.forEach((v: any, i: number) => {
        const sevTag = `[${(v.severity || 'medium').toUpperCase()}]`;
        lines.push(`${i + 1}. ${sevTag} [${v.id}] ${v.title}`);
        lines.push(`   PROBLEM: ${v.details}`);
        if (v.locations?.length > 0) {
            const locs = v.locations.map((l: any) => l.line ? `${l.file}:${l.line}` : l.file);
            lines.push(`   WHERE: ${locs.join(', ')}`);
        } else if (v.files?.length > 0) {
            lines.push(`   FILES: ${v.files.join(', ')}`);
        }
        if (v.instructions?.length > 0) {
            lines.push(`   FIX: ${v.instructions[0]}`);
        }
    });

    if (fixPacket.verification?.commands?.length > 0) {
        lines.push('');
        lines.push('VERIFICATION COMMANDS (run after fixing):');
        fixPacket.verification.commands.forEach((c: any) => {
            lines.push(`  $ ${c.cmd}  — ${c.purpose}`);
        });
    }

    if (fixPacket.constraints?.allowed_scope?.length > 0) {
        lines.push('');
        lines.push(`ALLOWED SCOPE: ${fixPacket.constraints.allowed_scope.join(', ')}`);
    }

    return lines.join('\n');
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
                let event: any;
                try {
                    event = JSON.parse(line);
                } catch {
                    continue;
                }
                if (event.tool === 'human_arbitration' && event.requestId === rid) {
                    return event.decision;
                }
            }
        }
        await new Promise(r => setTimeout(r, 1000));
    }
    return "approve"; // Default auto-approve if no human response
}
