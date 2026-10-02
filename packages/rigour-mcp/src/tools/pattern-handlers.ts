/**
 * Pattern Intelligence Tool Handlers
 *
 * Handlers for: rigour_check_pattern, rigour_security_audit
 *
 * @since v2.17.0 — extracted from monolithic index.ts
 */
import path from "path";
import yaml from "yaml";
import fs from "fs-extra";
import {
    assessPattern,
    loadPatternIndex,
    getDefaultIndexPath,
    SecurityDetector,
} from "@rigour-labs/core/pattern-index";
import { ConfigSchema, estimateTokenCount } from "@rigour-labs/core";
import { notifyProgress } from '../utils/notifications.js';
import { buildTelemetryMeta, type GuidanceMeta, type ToolResult } from '../utils/context-telemetry.js';
import { appendContextFooter } from '../utils/context-footer.js';

/**
 * Check if a file path is protected by safety.protected_paths in rigour.yml.
 * Returns the matched pattern or null.
 */
async function checkFileGuard(cwd: string, filePath: string): Promise<string | null> {
    const configPath = path.join(cwd, 'rigour.yml');
    let protectedPaths: string[] = [];
    try {
        if (await fs.pathExists(configPath)) {
            const raw = yaml.parse(await fs.readFile(configPath, 'utf-8'));
            const config = ConfigSchema.parse(raw);
            protectedPaths = config.gates.safety?.protected_paths ?? [];
        }
    } catch {
        // Default protected paths if no config
        protectedPaths = ['.github/**', 'rigour.yml'];
    }

    if (protectedPaths.length === 0) return null;

    const normalized = filePath.replace(/\\/g, '/');
    return protectedPaths.find(pattern => {
        const clean = pattern.replace('/**', '').replace('/*', '');
        if (normalized === clean) return true;
        if (clean.endsWith('/')) return normalized.startsWith(clean);
        return normalized.startsWith(clean + '/');
    }) ?? null;
}

export async function handleCheckPattern(
    cwd: string,
    patternName: string,
    type?: string,
    intent?: string,
    file?: string,
    signature?: string,
    keywords?: string[],
): Promise<ToolResult> {
    // No answer cache: a cache keyed on the commit kept naming functions renamed since, and the
    // index lookup it saved is milliseconds.
    const indexPath = getDefaultIndexPath(cwd);
    const index = await loadPatternIndex(indexPath);
    const indexScanEstimate = index
        ? `Pattern index scan (${index.stats.totalPatterns} patterns) for ${patternName}`
        : `Full pattern discovery for ${patternName}`;

    let resultText = "";
    let matchedPattern: { id: string; name: string; file: string } | undefined;

    // 0. File Guard — BLOCK writes to protected paths
    if (file) {
        const matched = await checkFileGuard(cwd, file);
        if (matched) {
            notifyProgress("error", `BLOCKED: Write to protected path ${file}`);
            resultText = `🛑 BLOCKED: You CANNOT write to "${file}".\n`;
            resultText += `This path matches protected pattern "${matched}" in rigour.yml.\n`;
            resultText += `CI/CD pipelines, governance configs, and protected docs require human review.\n\n`;
            resultText += `RECOMMENDED ACTION: STOP. Do not create or modify this file. Ask the human to make this change manually.`;

            const telemetry = buildTelemetryMeta({
                candidateText: indexScanEstimate,
                returnedText: resultText,
                cacheStatus: 'miss',
            });
            return {
                content: [{ type: "text", text: appendContextFooter(resultText, telemetry) }],
                _telemetry: telemetry,
                _guidance: {
                    kind: 'pattern',
                    query: patternName,
                    recommendation: `STOP. Do not modify protected path "${file}" without human review.`,
                    selectedFiles: [file],
                },
            };
        }
    }

    // 1. Reuse: does it exist already, and is what would be reused out of date?
    let action: 'BLOCK' | 'WARN' | 'ALLOW' = 'ALLOW';
    if (index) {
        const assessment = await assessPattern(cwd, index, { name: patternName, type, intent, signature, keywords });
        action = assessment.action;
        if (assessment.match) {
            const best = assessment.match;
            matchedPattern = best.pattern;
            resultText += action === 'BLOCK' ? `🚨 PATTERN REINVENTION DETECTED\n` : `💡 SIMILAR PATTERN EXISTS\n`;
            resultText += `"${best.pattern.name}" in ${best.pattern.file}:${best.pattern.line} (${best.matchType}, ${best.confidence}%)\n`;
            resultText += `SUGGESTION: ${assessment.suggestion}\n\n`;
        }
        if (assessment.deprecations.length) {
            resultText += `⚠️ THE EXISTING "${matchedPattern?.name}" USES SOMETHING DEPRECATED\n`;
            for (const issue of assessment.deprecations) resultText += `- ${issue.reason}\n  REPLACEMENT: ${issue.replacement}\n`;
            resultText += `\n`;
        }
    } else {
        resultText += `⚠️ Pattern index not found. Run rigour_index to enable reinvention detection.\n\n`;
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

    let recommendation = 'Proceed with implementation; no conflicting codebase pattern was found.';
    if (!resultText) {
        resultText = `✅ Pattern "${patternName}" is fresh, secure, and unique to the codebase.\n\nRECOMMENDED ACTION: Proceed with implementation.`;
    } else {
        recommendation = "Proceed with caution, addressing the warnings above.";
        if (action === 'BLOCK') {
            recommendation = "STOP and REUSE the existing pattern mentioned above. Do not create a duplicate.";
        } else if (action === 'WARN') {
            recommendation = "Look at the similar pattern above and reuse it if it does what you need; otherwise proceed.";
        } else if (resultText.includes("🛡️ SECURITY/CVE WARNING")) {
            recommendation = "STOP and update your dependencies or find an alternative library. Do not proceed with vulnerable code.";
        } else if (resultText.includes("⚠️ STALENESS")) {
            recommendation = "Follow the replacement suggestion to ensure best practices.";
        }
        resultText += `\nRECOMMENDED ACTION: ${recommendation}`;
    }

    const guidance: GuidanceMeta = {
        kind: 'pattern',
        query: patternName,
        recommendation,
        patternRefs: matchedPattern ? [{ id: matchedPattern.id, label: matchedPattern.name, file: matchedPattern.file }] : [],
        selectedFiles: file ? [file] : matchedPattern?.file ? [matchedPattern.file] : [],
    };

    const telemetry = buildTelemetryMeta({
        candidateText: indexScanEstimate,
        returnedText: resultText,
        cacheStatus: 'miss',
        deduplicatedTokens: index
            ? Math.max(0, estimateTokenCount(indexScanEstimate) - estimateTokenCount(resultText))
            : 0,
    });

    return {
        content: [{
            type: "text",
            text: appendContextFooter(resultText, telemetry, 'rigour_check before declaring done'),
        }],
        _telemetry: telemetry,
        _guidance: guidance,
    };
}

export async function handleSecurityAudit(cwd: string): Promise<ToolResult> {
    notifyProgress("info", "Running CVE security audit...");
    const security = new SecurityDetector(cwd);
    const summary = await security.getSecuritySummary();
    notifyProgress("info", "Security audit complete");
    return {
        content: [{ type: "text", text: summary }],
        _telemetry: buildTelemetryMeta({
            candidateText: summary,
            returnedText: summary,
            cacheStatus: 'none',
        }),
    };
}
