/**
 * Pattern Intelligence Tool Handlers
 *
 * Handlers for: rigour_check_pattern, rigour_security_audit
 *
 * @since v2.17.0 — extracted from monolithic index.ts
 */
import {
    PatternMatcher,
    loadPatternIndex,
    getDefaultIndexPath,
    StalenessDetector,
    SecurityDetector,
} from "@rigour-labs/core/pattern-index";
import { notifyProgress } from '../utils/notifications.js';

type ToolResult = { content: { type: string; text: string }[] };

export async function handleCheckPattern(
    cwd: string,
    patternName: string,
    type?: string,
    intent?: string
): Promise<ToolResult> {
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

    return { content: [{ type: "text", text: resultText }] };
}

export async function handleSecurityAudit(cwd: string): Promise<ToolResult> {
    notifyProgress("info", "Running CVE security audit...");
    const security = new SecurityDetector(cwd);
    const summary = await security.getSecuritySummary();
    notifyProgress("info", "Security audit complete");
    return { content: [{ type: "text", text: summary }] };
}
