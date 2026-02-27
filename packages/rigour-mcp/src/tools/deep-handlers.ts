/**
 * Deep Analysis Tool Handlers
 *
 * Handlers for: rigour_check_deep, rigour_deep_stats
 *
 * @since v4.0.0
 */
import path from "path";
import { GateRunner, Report } from "@rigour-labs/core";
import type { Config, DeepOptions } from "@rigour-labs/core";

type ToolResult = { content: { type: string; text: string }[]; isError?: boolean; _rigour_report?: Report };

function resolveDeepExecution(args: { apiKey?: string; provider?: string }): { isLocal: boolean; provider: string } {
    const requestedProvider = (args.provider || '').toLowerCase();
    const isForcedLocal = requestedProvider === 'local';
    const isLocal = !args.apiKey || isForcedLocal;
    return {
        isLocal,
        provider: isLocal ? 'local' : (args.provider || 'claude'),
    };
}

function isTestRuntime(): boolean {
    return !!(process.env.VITEST || process.env.VITEST_POOL_ID || process.env.NODE_ENV === 'test');
}

/**
 * Run quality gates with deep LLM-powered analysis.
 */
export async function handleCheckDeep(
    runner: GateRunner,
    cwd: string,
    config: Config,
    args: {
        pro?: boolean;
        apiKey?: string;
        provider?: string;
        apiBaseUrl?: string;
        modelName?: string;
    }
): Promise<ToolResult> {
    const execution = resolveDeepExecution(args);
    const deepOpts: DeepOptions & { onProgress?: (msg: string) => void } = {
        enabled: true,
        pro: !!args.pro,
        apiKey: args.apiKey,
        provider: execution.provider,
        apiBaseUrl: args.apiBaseUrl,
        modelName: args.modelName,
    };

    const report = await runner.run(cwd, undefined, deepOpts);

    // Persist to SQLite (best-effort). Skip during tests to avoid CI timing flakes.
    if (!isTestRuntime()) {
        try {
            const { openDatabase, insertScan, insertFindings } = await import('@rigour-labs/core');
            const db = openDatabase();
            if (db) {
                const repoName = path.basename(cwd);
                const scanId = insertScan(db, repoName, report, {
                    deepTier: args.pro ? 'pro' : (execution.isLocal ? 'deep' : 'cloud'),
                    deepModel: report.stats.deep?.model,
                });
                insertFindings(db, scanId, report.failures);
                db.close();
            }
        } catch {
            // SQLite persistence is best-effort
        }
    }

    // Format response
    const stats = report.stats;
    const aiHealth = stats.ai_health_score ?? 100;
    const codeQuality = stats.code_quality_score ?? stats.structural_score ?? 100;
    const overall = stats.score ?? 100;
    const isLocal = execution.isLocal;

    let text = `RIGOUR DEEP ANALYSIS: ${report.status}\n\n`;
    text += `AI Health:     ${aiHealth}/100\n`;
    text += `Code Quality:  ${codeQuality}/100\n`;
    text += `Overall:       ${overall}/100\n\n`;

    if (isLocal) {
        text += `🔒 Local sidecar/model execution. Code remains on this machine.\n`;
    } else {
        text += `☁️  Cloud provider execution. Code context may be sent to ${execution.provider} API.\n`;
    }

    if (stats.deep) {
        const tier = stats.deep.tier === 'cloud' ? execution.provider : stats.deep.tier;
        const model = stats.deep.model || 'unknown';
        const inferenceSec = stats.deep.total_ms ? (stats.deep.total_ms / 1000).toFixed(1) + 's' : '';
        text += `Model: ${model} (${tier}) ${inferenceSec}\n`;
    }

    if (report.failures.length > 0) {
        text += `\n--- Findings (${report.failures.length}) ---\n\n`;

        // Group by provenance
        const grouped: Record<string, typeof report.failures> = {};
        for (const f of report.failures) {
            const prov = f.provenance || 'traditional';
            if (!grouped[prov]) grouped[prov] = [];
            grouped[prov].push(f);
        }

        for (const [prov, failures] of Object.entries(grouped)) {
            text += `[${prov}] (${failures.length} issues)\n`;
            for (const f of failures.slice(0, 10)) {
                const sev = (f.severity || 'medium').toUpperCase();
                const conf = (f as any).confidence ? ` (${((f as any).confidence * 100).toFixed(0)}%)` : '';
                text += `  ${sev}: ${f.title}${conf}\n`;
                if (f.hint) text += `    → ${f.hint}\n`;
            }
            if (failures.length > 10) {
                text += `  ... +${failures.length - 10} more\n`;
            }
            text += '\n';
        }
    }

    text += `\nDuration: ${(stats.duration_ms / 1000).toFixed(1)}s`;

    const result: ToolResult = {
        content: [{ type: "text", text }],
    };
    result._rigour_report = report;
    return result;
}

/**
 * Get deep analysis statistics from SQLite storage.
 */
export async function handleDeepStats(cwd: string, limit = 10): Promise<ToolResult> {
    try {
        const { openDatabase, getRecentScans, getScoreTrendFromDB, getTopIssues } = await import('@rigour-labs/core');
        const db = openDatabase();

        if (!db) {
            return {
                content: [{ type: "text", text: "SQLite storage not available. Run `rigour check --deep` first to generate scan data." }],
            };
        }

        const repoName = path.basename(cwd);
        const scans = getRecentScans(db, repoName, limit);
        const trend = getScoreTrendFromDB(db, repoName, limit);
        const topIssues = getTopIssues(db, repoName, 10);
        db.close();

        if (scans.length === 0) {
            return {
                content: [{ type: "text", text: `No deep analysis scans found for "${repoName}". Run \`rigour check --deep\` first.` }],
            };
        }

        let text = `DEEP ANALYSIS STATS for "${repoName}"\n\n`;

        // Score trend
        text += `Score Trend: ${trend.scores.join(' → ')} (${trend.direction})\n\n`;

        // Recent scans
        text += `Recent Scans (${scans.length}):\n`;
        for (const scan of scans) {
            const date = new Date(scan.timestamp).toISOString().split('T')[0];
            const tier = (scan as any).deep_tier || '?';
            text += `  ${date} | Overall: ${(scan as any).overall_score ?? '?'}/100 | AI: ${(scan as any).ai_health_score ?? '?'}/100 | Quality: ${(scan as any).code_quality_score ?? '?'}/100 | Tier: ${tier}\n`;
        }

        // Top issues
        if (topIssues.length > 0) {
            text += `\nTop Issue Categories:\n`;
            for (const issue of topIssues) {
                text += `  ${issue.category}: ${issue.count} occurrences\n`;
            }
        }

        return { content: [{ type: "text", text }] };

    } catch (error: any) {
        return {
            content: [{ type: "text", text: `Error reading deep stats: ${error.message}` }],
            isError: true,
        };
    }
}
