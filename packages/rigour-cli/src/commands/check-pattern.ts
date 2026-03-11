/**
 * Pattern Check CLI Command
 *
 * Wraps the same core logic as the MCP `rigour_check_pattern` tool.
 * Three-layer check before creating new code:
 * 1. Reinvention detection (pattern index fuzzy match)
 * 2. Staleness / anti-pattern detection
 * 3. Security / CVE check (when intent includes imports)
 *
 * Usage:
 *   rigour check-pattern --name useDebounce --type hook --intent "debounce user input"
 *   rigour check-pattern --name formatDate --type function --json
 */
import chalk from 'chalk';
import {
    PatternMatcher,
    loadPatternIndex,
    getDefaultIndexPath,
    StalenessDetector,
    SecurityDetector,
} from '@rigour-labs/core/pattern-index';

const EXIT_PASS = 0;
const EXIT_FAIL = 1;
const EXIT_INTERNAL_ERROR = 3;

export interface CheckPatternOptions {
    name: string;
    type?: string;
    intent?: string;
    json?: boolean;
}

export async function checkPatternCommand(cwd: string, options: CheckPatternOptions) {
    const { name: patternName, type, intent } = options;

    if (!patternName) {
        if (options.json) {
            console.log(JSON.stringify({ error: 'INPUT_ERROR', message: '--name is required' }));
        } else {
            console.error(chalk.red('Error: --name is required.'));
        }
        process.exit(EXIT_FAIL);
    }

    try {
        const findings: Array<{
            level: 'error' | 'warning' | 'info';
            category: string;
            message: string;
            suggestion?: string;
        }> = [];

        // 1. Check for Reinvention
        const indexPath = getDefaultIndexPath(cwd);
        const index = await loadPatternIndex(indexPath);
        if (index) {
            const matcher = new PatternMatcher(index);
            const matchResult = await matcher.match({ name: patternName, type, intent });
            if (matchResult.status === 'FOUND_SIMILAR') {
                findings.push({
                    level: 'error',
                    category: 'reinvention',
                    message: `Similar pattern already exists: "${matchResult.matches[0].pattern.name}" in ${matchResult.matches[0].pattern.file}`,
                    suggestion: matchResult.suggestion,
                });
            }
        } else {
            findings.push({
                level: 'info',
                category: 'index_missing',
                message: 'Pattern index not found. Run `rigour index` to enable reinvention detection.',
            });
        }

        // 2. Check for Staleness / Anti-patterns
        const detector = new StalenessDetector(cwd);
        const staleness = await detector.checkStaleness(`${type || 'function'} ${patternName} {}`);
        if (staleness.status !== 'FRESH') {
            for (const issue of staleness.issues) {
                findings.push({
                    level: 'warning',
                    category: 'staleness',
                    message: issue.reason,
                    suggestion: issue.replacement,
                });
            }
        }

        // 3. Security / CVE check (when intent suggests imports)
        if (intent && intent.includes('import')) {
            const security = new SecurityDetector(cwd);
            const audit = await security.runAudit();
            const relatedVulns = audit.vulnerabilities.filter((v: any) =>
                patternName.toLowerCase().includes(v.packageName.toLowerCase()) ||
                intent.toLowerCase().includes(v.packageName.toLowerCase())
            );
            if (relatedVulns.length > 0) {
                for (const v of relatedVulns) {
                    findings.push({
                        level: 'error',
                        category: 'security',
                        message: `[${v.severity.toUpperCase()}] ${v.packageName}: ${v.title}`,
                        suggestion: v.url,
                    });
                }
            }
        }

        // Determine overall status
        const hasErrors = findings.some(f => f.level === 'error');
        const hasWarnings = findings.some(f => f.level === 'warning');
        const status = hasErrors ? 'FAIL' : 'PASS';

        // Determine recommendation
        let recommendation = 'Proceed with implementation.';
        if (findings.some(f => f.category === 'reinvention')) {
            recommendation = 'STOP and REUSE the existing pattern. Do not create a duplicate.';
        } else if (findings.some(f => f.category === 'security')) {
            recommendation = 'STOP and update dependencies or find an alternative.';
        } else if (hasWarnings) {
            recommendation = 'Proceed with caution, addressing the warnings above.';
        }

        // JSON output
        if (options.json) {
            const jsonOutput = JSON.stringify({
                status,
                pattern: patternName,
                type: type || 'function',
                intent: intent || '',
                findings,
                recommendation,
            }, null, 2);
            process.stdout.write(jsonOutput + '\n', () => {
                process.exit(status === 'PASS' ? EXIT_PASS : EXIT_FAIL);
            });
            return;
        }

        // Human-readable output
        console.log(chalk.bold(`\nPattern Check: ${patternName}\n`));

        if (findings.length === 0) {
            console.log(chalk.green(`✅ Pattern "${patternName}" is fresh, secure, and unique to the codebase.\n`));
        } else {
            for (const f of findings) {
                const icon = f.level === 'error' ? chalk.red('🚨') :
                             f.level === 'warning' ? chalk.yellow('⚠️') :
                             chalk.dim('ℹ️');
                console.log(`${icon} [${f.category.toUpperCase()}] ${f.message}`);
                if (f.suggestion) {
                    console.log(chalk.cyan(`   → ${f.suggestion}`));
                }
            }
            console.log('');
        }

        console.log(chalk.bold(`Recommendation: ${recommendation}\n`));
        process.exit(status === 'PASS' ? EXIT_PASS : EXIT_FAIL);

    } catch (error: any) {
        if (options.json) {
            console.log(JSON.stringify({ error: 'INTERNAL_ERROR', message: error.message }));
        } else {
            console.error(chalk.red(`Internal error: ${error.message}`));
        }
        process.exit(EXIT_INTERNAL_ERROR);
    }
}
