/**
 * Security Audit CLI Command
 *
 * Wraps the same core logic as the MCP `rigour_security_audit` tool.
 * Runs CVE scanning against project dependencies.
 *
 * Usage:
 *   rigour security-audit
 *   rigour security-audit --json
 */
import chalk from 'chalk';
import { SecurityDetector } from '@rigour-labs/core/pattern-index';

const EXIT_PASS = 0;
const EXIT_FAIL = 1;
const EXIT_INTERNAL_ERROR = 3;

export interface SecurityAuditOptions {
    json?: boolean;
    ci?: boolean;
}

export async function securityAuditCommand(cwd: string, options: SecurityAuditOptions = {}) {
    try {
        const security = new SecurityDetector(cwd);

        if (options.json) {
            // For JSON mode, get the raw audit data
            const audit = await security.runAudit();
            const status = audit.vulnerabilities.length > 0 ? 'FAIL' : 'PASS';

            const jsonOutput = JSON.stringify({
                status,
                total_vulnerabilities: audit.vulnerabilities.length,
                vulnerabilities: audit.vulnerabilities.map((v: any) => ({
                    package: v.packageName,
                    severity: v.severity,
                    title: v.title,
                    url: v.url,
                    fixAvailable: v.fixAvailable,
                })),
            }, null, 2);

            process.stdout.write(jsonOutput + '\n', () => {
                process.exit(status === 'PASS' ? EXIT_PASS : EXIT_FAIL);
            });
            return;
        }

        // Human-readable: delegate to SecurityDetector's formatted summary
        const summary = await security.getSecuritySummary();

        if (options.ci) {
            // CI mode: compact
            console.log(summary.includes('No known vulnerabilities') ? 'PASS' : 'FAIL');
            console.log(summary);
            const hasVulns = !summary.includes('No known vulnerabilities');
            process.exit(hasVulns ? EXIT_FAIL : EXIT_PASS);
        }

        console.log(chalk.bold('\nSecurity Audit\n'));
        console.log(summary);
        console.log('');

        const hasVulns = !summary.includes('No known vulnerabilities');
        process.exit(hasVulns ? EXIT_FAIL : EXIT_PASS);

    } catch (error: any) {
        if (options.json) {
            console.log(JSON.stringify({ error: 'INTERNAL_ERROR', message: error.message }));
        } else {
            console.error(chalk.red(`Internal error: ${error.message}`));
        }
        process.exit(EXIT_INTERNAL_ERROR);
    }
}
