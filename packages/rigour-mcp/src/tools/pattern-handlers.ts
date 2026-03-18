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
    PatternMatcher,
    loadPatternIndex,
    getDefaultIndexPath,
    StalenessDetector,
    SecurityDetector,
} from "@rigour-labs/core/pattern-index";
import { ConfigSchema } from "@rigour-labs/core";
import { notifyProgress } from '../utils/notifications.js';

type ToolResult = { content: { type: string; text: string }[] };

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
): Promise<ToolResult> {
    let resultText = "";

    // 0. File Guard — BLOCK writes to protected paths
    if (file) {
        const matched = await checkFileGuard(cwd, file);
        if (matched) {
            notifyProgress("error", `BLOCKED: Write to protected path ${file}`);
            resultText = `🛑 BLOCKED: You CANNOT write to "${file}".\n`;
            resultText += `This path matches protected pattern "${matched}" in rigour.yml.\n`;
            resultText += `CI/CD pipelines, governance configs, and protected docs require human review.\n\n`;
            resultText += `RECOMMENDED ACTION: STOP. Do not create or modify this file. Ask the human to make this change manually.`;
            return { content: [{ type: "text", text: resultText }] };
        }
    }

    // 1. Check for Reinvention
    const indexPath = getDefaultIndexPath(cwd);
    const index = await loadPatternIndex(indexPath);
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

    return { content: [{ type: "text", text: resultText }] };
}

export async function handleSecurityAudit(cwd: string): Promise<ToolResult> {
    notifyProgress("info", "Running CVE security audit...");
    const security = new SecurityDetector(cwd);
    const summary = await security.getSecuritySummary();
    notifyProgress("info", "Security audit complete");
    return { content: [{ type: "text", text: summary }] };
}
