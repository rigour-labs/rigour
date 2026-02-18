/**
 * Security Patterns Gate
 * 
 * Detects code-level security vulnerabilities for frontier models
 * that may generate insecure patterns at scale.
 * 
 * Patterns covered:
 * - SQL Injection
 * - XSS (Cross-Site Scripting)
 * - Path Traversal
 * - Hardcoded Secrets
 * - Insecure Randomness
 * - Command Injection
 * 
 * @since v2.14.0
 */

import { Gate, GateContext } from './base.js';
import { Failure, Provenance } from '../types/index.js';
import { FileScanner } from '../utils/scanner.js';
import { Logger } from '../utils/logger.js';
import fs from 'fs-extra';
import path from 'path';

export interface SecurityVulnerability {
    type: string;
    severity: 'critical' | 'high' | 'medium' | 'low';
    file: string;
    line: number;
    match: string;
    description: string;
    cwe?: string;
}

export interface SecurityPatternsConfig {
    enabled?: boolean;
    sql_injection?: boolean;
    xss?: boolean;
    path_traversal?: boolean;
    hardcoded_secrets?: boolean;
    insecure_randomness?: boolean;
    command_injection?: boolean;
    redos?: boolean;
    overly_permissive?: boolean;
    unsafe_output?: boolean;
    missing_input_validation?: boolean;
    block_on_severity?: 'critical' | 'high' | 'medium' | 'low';
}

// Pattern definitions with regex and metadata
const VULNERABILITY_PATTERNS: {
    type: string;
    regex: RegExp;
    severity: 'critical' | 'high' | 'medium' | 'low';
    description: string;
    cwe: string;
    languages: string[];
}[] = [
        // SQL Injection
        {
            type: 'sql_injection',
            regex: /(?:execute|query|raw|exec)\s*\(\s*[`'"].*\$\{.+\}|`\s*\+\s*\w+|\$\{.+\}.*(?:SELECT|INSERT|UPDATE|DELETE|DROP)/gi,
            severity: 'critical',
            description: 'Potential SQL injection: User input concatenated into SQL query',
            cwe: 'CWE-89',
            languages: ['ts', 'js', 'py']
        },
        {
            type: 'sql_injection',
            regex: /\.query\s*\(\s*['"`].*\+.*\+.*['"`]\s*\)/g,
            severity: 'critical',
            description: 'SQL query built with string concatenation',
            cwe: 'CWE-89',
            languages: ['ts', 'js']
        },
        // XSS
        {
            type: 'xss',
            regex: /innerHTML\s*=\s*(?!\s*['"`]\s*['"`])[^;]+/g,
            severity: 'high',
            description: 'Potential XSS: innerHTML assignment with dynamic content',
            cwe: 'CWE-79',
            languages: ['ts', 'js', 'tsx', 'jsx']
        },
        {
            type: 'xss',
            regex: /dangerouslySetInnerHTML\s*=\s*\{/g,
            severity: 'high',
            description: 'dangerouslySetInnerHTML usage (ensure content is sanitized)',
            cwe: 'CWE-79',
            languages: ['tsx', 'jsx']
        },
        {
            type: 'xss',
            regex: /document\.write\s*\(/g,
            severity: 'high',
            description: 'document.write is dangerous for XSS',
            cwe: 'CWE-79',
            languages: ['ts', 'js']
        },
        // Path Traversal
        {
            type: 'path_traversal',
            regex: /(?:readFile|writeFile|readdir|unlink|rmdir)\s*\([^)]*(?:req\.(?:params|query|body)|\.\.\/)/g,
            severity: 'high',
            description: 'Potential path traversal: File operation with user input',
            cwe: 'CWE-22',
            languages: ['ts', 'js']
        },
        {
            type: 'path_traversal',
            regex: /path\.join\s*\([^)]*req\./g,
            severity: 'medium',
            description: 'path.join with request data (verify input sanitization)',
            cwe: 'CWE-22',
            languages: ['ts', 'js']
        },
        // Hardcoded Secrets
        {
            type: 'hardcoded_secrets',
            regex: /(?:password|secret|api_key|apikey|auth_token|access_token|private_key)\s*[:=]\s*['"][^'"]{8,}['"]/gi,
            severity: 'critical',
            description: 'Hardcoded secret detected in code',
            cwe: 'CWE-798',
            languages: ['ts', 'js', 'py', 'java', 'go']
        },
        {
            type: 'hardcoded_secrets',
            regex: /(?:sk-|pk-|rk-|ghp_|gho_|ghu_|ghs_|ghr_)[a-zA-Z0-9]{20,}/g,
            severity: 'critical',
            description: 'API key pattern detected (OpenAI, GitHub, etc.)',
            cwe: 'CWE-798',
            languages: ['*']
        },
        {
            type: 'hardcoded_secrets',
            regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
            severity: 'critical',
            description: 'Private key embedded in source code',
            cwe: 'CWE-798',
            languages: ['*']
        },
        // Insecure Randomness
        {
            type: 'insecure_randomness',
            regex: /Math\.random\s*\(\s*\)/g,
            severity: 'medium',
            description: 'Math.random() is not cryptographically secure',
            cwe: 'CWE-338',
            languages: ['ts', 'js', 'tsx', 'jsx']
        },
        // Command Injection
        {
            type: 'command_injection',
            regex: /(?:exec|spawn|execSync|spawnSync)\s*\([^)]*(?:req\.|`.*\$\{)/g,
            severity: 'critical',
            description: 'Potential command injection: shell execution with user input',
            cwe: 'CWE-78',
            languages: ['ts', 'js']
        },
        {
            type: 'command_injection',
            regex: /child_process.*\s*\.\s*(?:exec|spawn)\s*\(/g,
            severity: 'high',
            description: 'child_process usage detected (verify input sanitization)',
            cwe: 'CWE-78',
            languages: ['ts', 'js']
        },
        // ReDoS — Denial of Service via regex (OWASP #7)
        {
            type: 'redos',
            regex: /new RegExp\s*\([^)]*(?:req\.|params|query|body|input|user)/g,
            severity: 'high',
            description: 'Dynamic regex from user input — potential ReDoS',
            cwe: 'CWE-1333',
            languages: ['ts', 'js']
        },
        {
            type: 'redos',
            regex: /\(\?:[^)]*\+[^)]*\)\+|\([^)]*\*[^)]*\)\+|\(\.\*\)\{/g,
            severity: 'medium',
            description: 'Regex with nested quantifiers — potential ReDoS',
            cwe: 'CWE-1333',
            languages: ['ts', 'js', 'py']
        },
        // Overly Permissive Code (OWASP #9)
        {
            type: 'overly_permissive',
            regex: /cors\s*\(\s*\{[^}]*origin\s*:\s*(?:true|['"`]\*['"`])/g,
            severity: 'high',
            description: 'CORS wildcard origin — allows any domain',
            cwe: 'CWE-942',
            languages: ['ts', 'js']
        },
        {
            type: 'overly_permissive',
            regex: /(?:listen|bind)\s*\(\s*(?:\d+\s*,\s*)?['"`]0\.0\.0\.0['"`]/g,
            severity: 'medium',
            description: 'Binding to 0.0.0.0 exposes service to all interfaces',
            cwe: 'CWE-668',
            languages: ['ts', 'js', 'py', 'go']
        },
        {
            type: 'overly_permissive',
            regex: /chmod\s*\(\s*[^,]*,\s*['"`]?(?:0o?)?777['"`]?\s*\)/g,
            severity: 'high',
            description: 'chmod 777 — world-readable/writable permissions',
            cwe: 'CWE-732',
            languages: ['ts', 'js', 'py']
        },
        {
            type: 'overly_permissive',
            regex: /(?:Access-Control-Allow-Origin|x-powered-by)['"`,\s:]+\*/gi,
            severity: 'high',
            description: 'Wildcard Access-Control-Allow-Origin header',
            cwe: 'CWE-942',
            languages: ['ts', 'js', 'py']
        },
        // Unsafe Output Handling (OWASP #6)
        {
            type: 'unsafe_output',
            regex: /res\.(?:send|write|end)\s*\(\s*(?:req\.|params|query|body|input|user)/g,
            severity: 'high',
            description: 'Reflecting user input in response without sanitization',
            cwe: 'CWE-79',
            languages: ['ts', 'js']
        },
        {
            type: 'unsafe_output',
            regex: /\$\{[^}]*(?:req\.|params|query|body|input|user)[^}]*\}.*(?:html|template|render)/gi,
            severity: 'high',
            description: 'User input interpolated into template/HTML output',
            cwe: 'CWE-79',
            languages: ['ts', 'js', 'py']
        },
        {
            type: 'unsafe_output',
            regex: /eval\s*\(\s*(?:req\.|params|query|body|input|user)/g,
            severity: 'critical',
            description: 'eval() with user input — code injection',
            cwe: 'CWE-94',
            languages: ['ts', 'js', 'py']
        },
        // Missing Input Validation (OWASP #8)
        {
            type: 'missing_input_validation',
            regex: /JSON\.parse\s*\(\s*(?:req\.body|request\.body|body|data|input)\s*\)/g,
            severity: 'medium',
            description: 'JSON.parse on raw input without schema validation',
            cwe: 'CWE-20',
            languages: ['ts', 'js']
        },
        {
            type: 'missing_input_validation',
            regex: /(?:as\s+any|:\s*any)\s*(?:[;,)\]}])/g,
            severity: 'medium',
            description: 'Type assertion to "any" bypasses type safety',
            cwe: 'CWE-20',
            languages: ['ts']
        },
    ];

export class SecurityPatternsGate extends Gate {
    private config: SecurityPatternsConfig;
    private severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };

    constructor(config: SecurityPatternsConfig = {}) {
        super('security-patterns', 'Security Pattern Detection');
        this.config = {
            enabled: config.enabled ?? true,
            sql_injection: config.sql_injection ?? true,
            xss: config.xss ?? true,
            path_traversal: config.path_traversal ?? true,
            hardcoded_secrets: config.hardcoded_secrets ?? true,
            insecure_randomness: config.insecure_randomness ?? true,
            command_injection: config.command_injection ?? true,
            redos: config.redos ?? true,
            overly_permissive: config.overly_permissive ?? true,
            unsafe_output: config.unsafe_output ?? true,
            missing_input_validation: config.missing_input_validation ?? true,
            block_on_severity: config.block_on_severity ?? 'high',
        };
    }

    protected get provenance(): Provenance { return 'security'; }

    async run(context: GateContext): Promise<Failure[]> {
        if (!this.config.enabled) {
            return [];
        }

        const failures: Failure[] = [];
        const vulnerabilities: SecurityVulnerability[] = [];

        const files = await FileScanner.findFiles({
            cwd: context.cwd,
            patterns: ['**/*.{ts,js,tsx,jsx,py,java,go}'],
        });

        Logger.info(`Security Patterns Gate: Scanning ${files.length} files`);

        for (const file of files) {
            try {
                const fullPath = path.join(context.cwd, file);
                const content = await fs.readFile(fullPath, 'utf-8');
                const ext = path.extname(file).slice(1);

                this.scanFileForVulnerabilities(content, file, ext, vulnerabilities);
            } catch (e) { }
        }

        // Filter by enabled checks
        const filteredVulns = vulnerabilities.filter(v => {
            switch (v.type) {
                case 'sql_injection': return this.config.sql_injection;
                case 'xss': return this.config.xss;
                case 'path_traversal': return this.config.path_traversal;
                case 'hardcoded_secrets': return this.config.hardcoded_secrets;
                case 'insecure_randomness': return this.config.insecure_randomness;
                case 'command_injection': return this.config.command_injection;
                case 'redos': return this.config.redos;
                case 'overly_permissive': return this.config.overly_permissive;
                case 'unsafe_output': return this.config.unsafe_output;
                case 'missing_input_validation': return this.config.missing_input_validation;
                default: return true;
            }
        });

        // Sort by severity
        filteredVulns.sort((a, b) =>
            this.severityOrder[a.severity] - this.severityOrder[b.severity]
        );

        // Convert to failures based on block_on_severity threshold
        const blockThreshold = this.severityOrder[this.config.block_on_severity ?? 'high'];

        for (const vuln of filteredVulns) {
            if (this.severityOrder[vuln.severity] <= blockThreshold) {
                failures.push(this.createFailure(
                    `[${vuln.cwe}] ${vuln.description}`,
                    [vuln.file],
                    `Found: "${vuln.match.slice(0, 60)}..." - Use parameterized queries/sanitization.`,
                    `Security: ${vuln.type.replace('_', ' ').toUpperCase()}`,
                    vuln.line,
                    vuln.line,
                    vuln.severity
                ));
            }
        }

        if (filteredVulns.length > 0 && failures.length === 0) {
            // Vulnerabilities found but below threshold - log info
            Logger.info(`Security scan found ${filteredVulns.length} issues below ${this.config.block_on_severity} threshold`);
        }

        return failures;
    }

    private scanFileForVulnerabilities(
        content: string,
        file: string,
        ext: string,
        vulnerabilities: SecurityVulnerability[]
    ): void {
        const lines = content.split('\n');

        for (const pattern of VULNERABILITY_PATTERNS) {
            // Check if pattern applies to this file type
            if (!pattern.languages.includes('*') && !pattern.languages.includes(ext)) {
                continue;
            }

            // Reset regex state
            pattern.regex.lastIndex = 0;

            let match;
            while ((match = pattern.regex.exec(content)) !== null) {
                // Find line number
                const beforeMatch = content.slice(0, match.index);
                const lineNumber = beforeMatch.split('\n').length;

                vulnerabilities.push({
                    type: pattern.type,
                    severity: pattern.severity,
                    file,
                    line: lineNumber,
                    match: match[0],
                    description: pattern.description,
                    cwe: pattern.cwe,
                });
            }
        }
    }
}

/**
 * Quick helper to check a single file for security issues
 */
export async function checkSecurityPatterns(
    filePath: string,
    config: SecurityPatternsConfig = { enabled: true }
): Promise<SecurityVulnerability[]> {
    const gate = new SecurityPatternsGate(config);
    const content = await fs.readFile(filePath, 'utf-8');
    const ext = path.extname(filePath).slice(1);
    const vulnerabilities: SecurityVulnerability[] = [];

    // Use the private method via reflection for testing
    (gate as any).scanFileForVulnerabilities(content, filePath, ext, vulnerabilities);

    return vulnerabilities;
}
