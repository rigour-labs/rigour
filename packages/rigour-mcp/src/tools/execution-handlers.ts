/**
 * Execution & Supervision Tool Handlers
 *
 * Handlers for: rigour_run, rigour_run_supervised
 * Agent Transaction Firewall: fail-closed arbitration + typed commands.
 */
import fs from "fs-extra";
import path from "path";
import { GateRunner, Report, FixPacketService, runTypedCommand, evaluateTypedCommand } from "@rigour-labs/core";
import type { Config } from "@rigour-labs/core";
import { logStudioEvent } from '../utils/config.js';
import { notifyProgress } from '../utils/notifications.js';

type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };

export async function handleRun(cwd: string, command: string, requestId: string): Promise<ToolResult> {
    const typed = evaluateTypedCommand(command);
    await logStudioEvent(cwd, {
        type: "interception_requested",
        requestId,
        tool: "rigour_run",
        command,
        firewallDecision: typed.decision,
        firewallReason: typed.reason,
        ruleId: typed.ruleId,
    });

    if (typed.decision !== 'allow') {
        await logStudioEvent(cwd, {
            type: "firewall_deny",
            requestId,
            tool: "rigour_run",
            decision: typed.decision,
            reason: typed.reason,
            ruleId: typed.ruleId,
        });
        return {
            content: [{
                type: "text",
                text: `❌ FIREWALL DENY (${typed.ruleId}): ${typed.reason}\nCommand: ${command}`,
            }],
            isError: true,
        };
    }

    console.error(`[RIGOUR] Waiting for human arbitration for command: ${command}`);

    const decision = await pollArbitration(cwd, requestId, 60000);

    if (decision === 'reject' || decision === 'timeout-deny' || decision === null) {
        await logStudioEvent(cwd, {
            type: "firewall_deny",
            requestId,
            tool: "human_arbitration",
            decision: decision ?? 'timeout-deny',
            reason: decision === 'reject' ? 'Human rejected' : 'Arbitration timed out (fail-closed)',
        });
        return {
            content: [{
                type: "text",
                text: decision === 'reject'
                    ? `❌ COMMAND REJECTED BY GOVERNOR: The execution of "${command}" was blocked by a human operator in the Governance Studio.`
                    : `❌ COMMAND DENIED (fail-closed): No human arbitration within 60s for "${command}".`,
            }],
            isError: true,
        };
    }

    try {
        const { stdout, stderr } = await runTypedCommand(command, cwd);
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

export async function handleRunSupervised(opts: {
    runner: GateRunner;
    cwd: string;
    command: string;
    maxRetries: number;
    dryRun: boolean;
    requestId: string;
    config?: Config;
}): Promise<ToolResult> {
    const { runner, cwd, command, maxRetries, dryRun, requestId, config } = opts;
    const typed = evaluateTypedCommand(command);
    if (typed.decision !== 'allow') {
        await logStudioEvent(cwd, {
            type: "firewall_deny",
            requestId,
            tool: "rigour_run_supervised",
            decision: typed.decision,
            reason: typed.reason,
            ruleId: typed.ruleId,
        });
        return {
            content: [{
                type: "text",
                text: `❌ FIREWALL DENY (${typed.ruleId}): ${typed.reason}\nCommand: ${command}`,
            }],
            isError: true,
        };
    }

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

    notifyProgress("info", `Supervisor started: ${command} (max ${maxRetries} retries)`);

    while (iteration < maxRetries) {
        iteration++;
        notifyProgress("info", `Supervisor iteration ${iteration}/${maxRetries}...`);

        if (!dryRun) {
            try {
                await runTypedCommand(command, cwd);
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
            notifyProgress("info", `Supervisor PASSED on iteration ${iteration} \u2014 Score: ${lastReport.stats.score ?? '?'}/100`);
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
            notifyProgress("error", `Supervisor FAILED after ${iteration} iterations \u2014 ${lastReport.failures.length} violations remain`);
            let fixPacketText: string;
            if (config) {
                const fixPacketService = new FixPacketService();
                const fixPacket = fixPacketService.generate(lastReport, config);
                fixPacketText = formatFixPacketForSupervisor(fixPacket);
            } else {
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

/**
 * Fail-closed: timeout with no human decision → timeout-deny (not approve).
 */
export async function pollArbitration(cwd: string, rid: string, timeout: number): Promise<string | null> {
    const eventsPath = path.join(cwd, '.rigour/events.jsonl');
    const maxIterations = Math.max(1, Math.ceil(timeout / 1000));
    for (let i = 0; i < maxIterations; i++) {
        const found = await readArbitrationDecision(eventsPath, rid);
        if (found) return found;
        await sleepMs(1000);
    }
    return "timeout-deny";
}

async function readArbitrationDecision(eventsPath: string, rid: string): Promise<string | null> {
    if (!(await fs.pathExists(eventsPath))) return null;
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
    return null;
}

function sleepMs(ms: number): Promise<void> {
    return new Promise(resolve => {
        const timerId = setTimeout(() => {
            clearTimeout(timerId);
            resolve();
        }, ms);
    });
}
