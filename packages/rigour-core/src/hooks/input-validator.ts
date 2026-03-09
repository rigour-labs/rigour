/**
 * Input Validation Gate — AI Agent DLP (Data Loss Prevention)
 *
 * Scans user input text for credentials, secrets, and sensitive data
 * BEFORE it reaches any AI agent. This is the pre-input counterpart
 * to the existing post-output security patterns in checker.ts.
 *
 * Supported credential types:
 * - AWS Access Keys (AKIA...)
 * - OpenAI / Anthropic / GitHub API keys (sk-*, ghp_*, etc.)
 * - Private keys (PEM format)
 * - Database connection strings (postgresql://, mongodb://, mysql://, redis://)
 * - Bearer tokens and JWTs
 * - Generic password/secret assignments
 * - .env format strings (KEY=value)
 * - Azure / GCP / Stripe / Twilio keys
 *
 */

export interface CredentialDetection {
    type: string;
    severity: 'critical' | 'high' | 'medium';
    match: string;
    redacted: string;
    description: string;
    recommendation: string;
    compliance: string[];
    position?: { start: number; end: number };
}

export interface InputValidationResult {
    status: 'clean' | 'blocked' | 'warning';
    detections: CredentialDetection[];
    duration_ms: number;
    scanned_length: number;
}

export interface InputValidationConfig {
    enabled?: boolean;
    block_on_detection?: boolean;
    /** Minimum length for generic secret values to avoid false positives */
    min_secret_length?: number;
    /** Custom patterns to add (regex strings) */
    custom_patterns?: string[];
    /** Patterns to ignore (regex strings for whitelisting) */
    ignore_patterns?: string[];
    /** Log blocked inputs to audit trail */
    audit_log?: boolean;
}

// ── Credential Pattern Definitions ────────────────────────────────

interface CredentialPattern {
    type: string;
    regex: RegExp;
    severity: 'critical' | 'high' | 'medium';
    description: string;
    recommendation: string;
    compliance: string[];
}

const CREDENTIAL_PATTERNS: CredentialPattern[] = [
    // ── Cloud Provider Keys ───────────────────────────────────
    {
        type: 'aws_access_key',
        regex: /\b(AKIA[0-9A-Z]{16})\b/g,
        severity: 'critical',
        description: 'AWS Access Key ID detected',
        recommendation: 'Use process.env.AWS_ACCESS_KEY_ID or AWS credentials file instead',
        compliance: ['SOC2-CC6.1', 'HIPAA-164.312', 'PCI-DSS-3.4'],
    },
    {
        type: 'aws_secret_key',
        regex: /(?:aws_secret_access_key|aws_secret_key|AWS_SECRET)\s*[:=]\s*['"]?([A-Za-z0-9/+=]{40})['"]?/gi,
        severity: 'critical',
        description: 'AWS Secret Access Key detected',
        recommendation: 'Use process.env.AWS_SECRET_ACCESS_KEY instead',
        compliance: ['SOC2-CC6.1', 'HIPAA-164.312', 'PCI-DSS-3.4'],
    },
    {
        type: 'gcp_service_account',
        regex: /("type"\s*:\s*"service_account"[\s\S]{0,200}"private_key"\s*:\s*"-----BEGIN)/g,
        severity: 'critical',
        description: 'GCP Service Account JSON key detected',
        recommendation: 'Use GOOGLE_APPLICATION_CREDENTIALS env var pointing to key file',
        compliance: ['SOC2-CC6.1', 'CIS-GCP-1.4'],
    },
    {
        type: 'azure_key',
        regex: /(?:AccountKey|SharedAccessKey|azure[_-]?(?:storage|cosmos|sb)[_-]?key)\s*[:=]\s*['"]?([A-Za-z0-9+/=]{44,88})['"]?/gi,
        severity: 'critical',
        description: 'Azure access key detected',
        recommendation: 'Use Azure Managed Identity or environment variables',
        compliance: ['SOC2-CC6.1', 'CIS-Azure-5.1'],
    },

    // ── API Keys (Provider-Specific Prefixes) ─────────────────
    {
        type: 'openai_key',
        regex: /\b(sk-(?:proj-)?[A-Za-z0-9]{20,})\b/g,
        severity: 'critical',
        description: 'OpenAI API key detected',
        recommendation: 'Use process.env.OPENAI_API_KEY instead',
        compliance: ['SOC2-CC6.1'],
    },
    {
        type: 'anthropic_key',
        regex: /\b(sk-ant-[A-Za-z0-9-]{20,})\b/g,
        severity: 'critical',
        description: 'Anthropic API key detected',
        recommendation: 'Use process.env.ANTHROPIC_API_KEY instead',
        compliance: ['SOC2-CC6.1'],
    },
    {
        type: 'github_token',
        regex: /\b(ghp_[A-Za-z0-9]{36}|gho_[A-Za-z0-9]{36}|ghu_[A-Za-z0-9]{36}|ghs_[A-Za-z0-9]{36}|ghr_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,})\b/g,
        severity: 'critical',
        description: 'GitHub token detected',
        recommendation: 'Use process.env.GITHUB_TOKEN or gh auth login instead',
        compliance: ['SOC2-CC6.1', 'CIS-SCM-1.2'],
    },
    {
        type: 'stripe_key',
        regex: /\b(sk_(?:live|test)_[A-Za-z0-9]{24,}|pk_(?:live|test)_[A-Za-z0-9]{24,}|rk_(?:live|test)_[A-Za-z0-9]{24,})\b/g,
        severity: 'critical',
        description: 'Stripe API key detected',
        recommendation: 'Use process.env.STRIPE_SECRET_KEY instead',
        compliance: ['SOC2-CC6.1', 'PCI-DSS-3.4'],
    },
    {
        type: 'twilio_key',
        regex: /\b(SK[a-f0-9]{32})\b/g,
        severity: 'high',
        description: 'Twilio API key detected',
        recommendation: 'Use process.env.TWILIO_API_KEY instead',
        compliance: ['SOC2-CC6.1'],
    },
    {
        type: 'slack_token',
        regex: /\b(xoxb-[0-9]{10,13}-[0-9]{10,13}-[a-zA-Z0-9]{24}|xoxp-[0-9]{10,13}-[0-9]{10,13}-[0-9]{10,13}-[a-f0-9]{32}|xapp-[0-9]-[A-Z0-9]{10,13}-[0-9]{13}-[a-zA-Z0-9]{64})\b/g,
        severity: 'critical',
        description: 'Slack token detected',
        recommendation: 'Use process.env.SLACK_TOKEN instead',
        compliance: ['SOC2-CC6.1'],
    },
    {
        type: 'sendgrid_key',
        regex: /\b(SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43})\b/g,
        severity: 'critical',
        description: 'SendGrid API key detected',
        recommendation: 'Use process.env.SENDGRID_API_KEY instead',
        compliance: ['SOC2-CC6.1'],
    },

    // ── Private Keys ──────────────────────────────────────────
    {
        type: 'private_key',
        regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ED25519 )?PRIVATE KEY-----/g,
        severity: 'critical',
        description: 'Private key detected in input',
        recommendation: 'Never paste private keys into AI agents. Use key file references instead',
        compliance: ['SOC2-CC6.1', 'HIPAA-164.312', 'PCI-DSS-3.5'],
    },

    // ── Database Connection Strings ───────────────────────────
    {
        type: 'database_url',
        regex: /\b((?:postgres(?:ql)?|mysql|mariadb|mssql|mongodb(?:\+srv)?|redis|rediss|amqp|amqps):\/\/[^\s'"`,;}{)]+)/gi,
        severity: 'critical',
        description: 'Database connection string with credentials detected',
        recommendation: 'Use process.env.DATABASE_URL instead',
        compliance: ['SOC2-CC6.1', 'HIPAA-164.312', 'PCI-DSS-6.5'],
    },

    // ── Bearer Tokens & JWTs ──────────────────────────────────
    {
        type: 'bearer_token',
        regex: /\b(Bearer\s+[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})\b/g,
        severity: 'critical',
        description: 'Bearer token (JWT) detected',
        recommendation: 'Use process.env.AUTH_TOKEN or a secure token store',
        compliance: ['SOC2-CC6.1', 'OWASP-A2'],
    },
    {
        type: 'jwt_token',
        regex: /\b(eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g,
        severity: 'high',
        description: 'JWT token detected in input',
        recommendation: 'Avoid sharing tokens with AI agents. Use environment variables',
        compliance: ['SOC2-CC6.1', 'OWASP-A2'],
    },

    // ── Generic Password/Secret Assignments ───────────────────
    {
        type: 'password_assignment',
        regex: /(?:password|passwd|pwd|secret|api[_-]?key|apikey|auth[_-]?token|access[_-]?token|client[_-]?secret|signing[_-]?key|encryption[_-]?key)\s*[:=]\s*['"]([^'"]{8,})['"]/gi,
        severity: 'high',
        description: 'Password or secret value detected',
        recommendation: 'Use environment variable: process.env.<KEY_NAME>',
        compliance: ['SOC2-CC6.1', 'CWE-798'],
    },

    // ── .env Format Strings ───────────────────────────────────
    {
        type: 'env_variable',
        regex: /^[A-Z][A-Z0-9_]{2,}=(?![\s]*$)['"]?[^\s'"]{8,}['"]?\s*$/gm,
        severity: 'high',
        description: '.env format secret detected (KEY=value)',
        recommendation: 'Reference the .env file path instead of pasting contents',
        compliance: ['SOC2-CC6.1', 'CWE-798'],
    },

    // ── SSH Connection Strings ────────────────────────────────
    {
        type: 'ssh_credentials',
        regex: /\bssh\s+(?:-i\s+\S+\s+)?[a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\s*(?:-p\s+\d+)?/g,
        severity: 'medium',
        description: 'SSH connection command detected',
        recommendation: 'Use SSH config aliases instead of full connection strings',
        compliance: ['SOC2-CC6.1'],
    },

    // ── IP Addresses with Credentials ─────────────────────────
    {
        type: 'credentials_in_url',
        regex: /\b(https?:\/\/[^:]+:[^@]+@[^\s'"`,;}{)]+)\b/gi,
        severity: 'critical',
        description: 'URL with embedded credentials detected',
        recommendation: 'Remove credentials from URLs. Use environment variables for auth',
        compliance: ['SOC2-CC6.1', 'CWE-798', 'OWASP-A2'],
    },

    // ── Base64-Encoded Secrets (v4.2+) ──────────────────────────
    {
        type: 'base64_secret',
        regex: /(?:api[_-]?key|password|secret|token|credential|auth)\s*[:=]\s*['"]?([A-Za-z0-9+/]{32,})={0,2}['"]?/gi,
        severity: 'high',
        description: 'Possible base64-encoded secret detected',
        recommendation: 'Use environment variables instead of encoded inline secrets',
        compliance: ['SOC2-CC6.1', 'CWE-798'],
    },

    // ── Hex-Encoded Secrets (v4.2+) ──────────────────────────────
    {
        type: 'hex_secret',
        regex: /(?:api[_-]?key|password|secret|token|credential|auth)\s*[:=]\s*['"]?([0-9a-f]{32,})['"]?/gi,
        severity: 'high',
        description: 'Possible hex-encoded secret detected',
        recommendation: 'Use environment variables instead of encoded inline secrets',
        compliance: ['SOC2-CC6.1', 'CWE-798'],
    },

    // ── Multiline Private Keys (v4.2+) ───────────────────────────
    {
        type: 'private_key_full',
        regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ED25519 )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |ED25519 )?PRIVATE KEY-----/g,
        severity: 'critical',
        description: 'Full private key block detected in input',
        recommendation: 'Never paste private keys into AI agents. Use key file references instead',
        compliance: ['SOC2-CC6.1', 'HIPAA-164.312', 'PCI-DSS-3.5'],
    },

    // ── Package.json / CI Secrets (v4.2+) ────────────────────────
    {
        type: 'ci_secret',
        regex: /(?:DOCKER_PASSWORD|NPM_TOKEN|PYPI_TOKEN|NUGET_API_KEY|SONAR_TOKEN|CODECOV_TOKEN|SNYK_TOKEN|SENTRY_DSN|DATADOG_API_KEY)\s*[:=]\s*['"]?([^\s'"`,;}{)]{8,})['"]?/gi,
        severity: 'critical',
        description: 'CI/CD or registry secret detected',
        recommendation: 'Use CI secret management (GitHub Secrets, GitLab CI Variables)',
        compliance: ['SOC2-CC6.1', 'CIS-SCM-2.3'],
    },
];

// ── Normalization & Entropy ───────────────────────────────────────

/**
 * Normalize input to defeat obfuscation tricks:
 * - Remove zero-width characters (U+200B, U+200C, U+200D, U+FEFF)
 * - Remove bidirectional control chars (RTLO, LRLO, etc.)
 * - NFC unicode normalization
 */
function normalizeInput(input: string): string {
    return input
        .replace(/[\u200B\u200C\u200D\uFEFF]/g, '')   // zero-width
        .replace(/[\u202A-\u202E\u061C\u2066-\u2069]/g, '') // bidi control
        .normalize('NFC');
}

/**
 * Shannon entropy — measures randomness of a string.
 * High entropy (>4.5) on long strings (>20 chars) suggests
 * encoded/encrypted secrets that bypass regex patterns.
 */
function shannonEntropy(str: string): number {
    const freq: Record<string, number> = {};
    for (const c of str) freq[c] = (freq[c] || 0) + 1;
    const len = str.length;
    return Object.values(freq).reduce((sum, f) => {
        const p = f / len;
        return sum - p * Math.log2(p);
    }, 0);
}

// ── Core Scanner ──────────────────────────────────────────────────

/**
 * Redact a matched credential for safe display.
 * Shows first 4 and last 2 chars, masks the rest.
 */
function redactMatch(match: string): string {
    if (match.length <= 10) {
        return match.substring(0, 3) + '***';
    }
    return match.substring(0, 4) + '****' + match.substring(match.length - 2);
}

/**
 * Scan input text for credential patterns.
 * Returns all detections with type, severity, and recommendations.
 *
 * Designed to complete in <50ms for real-time pre-input hooks.
 */
export function scanInputForCredentials(
    input: string,
    config: InputValidationConfig = {}
): InputValidationResult {
    const start = Date.now();
    const detections: CredentialDetection[] = [];

    if (!config.enabled && config.enabled !== undefined) {
        return {
            status: 'clean',
            detections: [],
            duration_ms: Date.now() - start,
            scanned_length: input.length,
        };
    }

    // ── Normalize to defeat obfuscation (zero-width chars, bidi, unicode) ──
    input = normalizeInput(input);

    const minSecretLength = config.min_secret_length ?? 8;
    const ignoreRegexes = (config.ignore_patterns ?? []).map(p => new RegExp(p, 'gi'));

    for (const pattern of CREDENTIAL_PATTERNS) {
        // Reset regex state for global patterns
        pattern.regex.lastIndex = 0;

        let match: RegExpExecArray | null;
        while ((match = pattern.regex.exec(input)) !== null) {
            const fullMatch = match[0];
            const capturedValue = match[1] || fullMatch;

            // Skip short matches to avoid false positives
            if (capturedValue.length < minSecretLength && pattern.type !== 'private_key') {
                continue;
            }

            // Check ignore patterns
            const isIgnored = ignoreRegexes.some(ignore => {
                ignore.lastIndex = 0;
                return ignore.test(fullMatch);
            });
            if (isIgnored) {
                continue;
            }

            detections.push({
                type: pattern.type,
                severity: pattern.severity,
                match: fullMatch.slice(0, 80),
                redacted: redactMatch(capturedValue),
                description: pattern.description,
                recommendation: pattern.recommendation,
                compliance: pattern.compliance,
                position: {
                    start: match.index,
                    end: match.index + fullMatch.length,
                },
            });
        }
    }

    // Add custom patterns if configured
    if (config.custom_patterns) {
        for (const customRegex of config.custom_patterns) {
            try {
                const regex = new RegExp(customRegex, 'gi');
                let match: RegExpExecArray | null;
                while ((match = regex.exec(input)) !== null) {
                    detections.push({
                        type: 'custom_pattern',
                        severity: 'high',
                        match: match[0].slice(0, 80),
                        redacted: redactMatch(match[0]),
                        description: `Custom pattern match: ${customRegex.slice(0, 40)}`,
                        recommendation: 'Use environment variables instead of inline secrets',
                        compliance: ['SOC2-CC6.1'],
                        position: {
                            start: match.index,
                            end: match.index + match[0].length,
                        },
                    });
                }
            } catch {
                // Invalid regex, skip
            }
        }
    }

    // ── Entropy-based detection: catch encoded/obfuscated secrets ──
    // Scan for high-entropy strings assigned to suspicious variable names
    const entropyRegex = /(?:key|secret|token|password|credential|auth|api_key)\s*[:=]\s*['"]([A-Za-z0-9+/=_-]{24,})['"]?/gi;
    entropyRegex.lastIndex = 0;
    let entropyMatch: RegExpExecArray | null;
    while ((entropyMatch = entropyRegex.exec(input)) !== null) {
        const value = entropyMatch[1];
        const entropy = shannonEntropy(value);
        if (entropy > 4.5 && value.length >= 24) {
            // Only add if not already caught by a more specific pattern
            const alreadyCaught = detections.some(d =>
                d.position && entropyMatch!.index >= d.position.start && entropyMatch!.index < d.position.end
            );
            if (!alreadyCaught) {
                detections.push({
                    type: 'high_entropy_secret',
                    severity: 'high',
                    match: entropyMatch[0].slice(0, 80),
                    redacted: redactMatch(value),
                    description: `High-entropy value (${entropy.toFixed(1)} bits) in secret assignment — likely encoded credential`,
                    recommendation: 'Use environment variables instead of inline secrets',
                    compliance: ['SOC2-CC6.1', 'CWE-798'],
                    position: { start: entropyMatch.index, end: entropyMatch.index + entropyMatch[0].length },
                });
            }
        }
    }

    // Deduplicate overlapping detections (keep highest severity)
    const deduped = deduplicateDetections(detections);

    // Sort by severity (critical first)
    const severityOrder = { critical: 0, high: 1, medium: 2 };
    deduped.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

    const blockOnDetection = config.block_on_detection ?? true;
    const status = deduped.length === 0
        ? 'clean'
        : blockOnDetection
            ? 'blocked'
            : 'warning';

    return {
        status,
        detections: deduped,
        duration_ms: Date.now() - start,
        scanned_length: input.length,
    };
}

/**
 * Deduplicate overlapping detections — keep the higher severity one.
 */
function deduplicateDetections(detections: CredentialDetection[]): CredentialDetection[] {
    if (detections.length <= 1) return detections;

    const sorted = [...detections].sort((a, b) => {
        const posA = a.position?.start ?? 0;
        const posB = b.position?.start ?? 0;
        return posA - posB;
    });

    const result: CredentialDetection[] = [];
    const severityOrder = { critical: 0, high: 1, medium: 2 };

    for (const detection of sorted) {
        const overlapping = result.find(existing => {
            if (!existing.position || !detection.position) return false;
            return detection.position.start < existing.position.end
                && detection.position.end > existing.position.start;
        });

        if (overlapping) {
            // Keep the higher severity detection
            if (severityOrder[detection.severity] < severityOrder[overlapping.severity]) {
                const idx = result.indexOf(overlapping);
                result[idx] = detection;
            }
        } else {
            result.push(detection);
        }
    }

    return result;
}

/**
 * Format a blocked input result for display in IDE/terminal.
 * Used by hooks and CLI for human-readable output.
 */
export function formatDLPAlert(result: InputValidationResult): string {
    if (result.status === 'clean') {
        return '✓ Input clean — no credentials detected.';
    }

    const icon = result.status === 'blocked' ? '🛑' : '⚠️';
    const header = result.status === 'blocked'
        ? `${icon} BLOCKED — ${result.detections.length} credential(s) detected in agent input`
        : `${icon} WARNING — ${result.detections.length} credential(s) detected in agent input`;

    const details = result.detections.map(d => {
        const complianceStr = d.compliance.length > 0
            ? `\n    Compliance: ${d.compliance.join(', ')}`
            : '';
        return [
            `  [${d.severity.toUpperCase()}] ${d.description}`,
            `    Detected: ${d.redacted}`,
            `    → ${d.recommendation}`,
            complianceStr,
        ].filter(Boolean).join('\n');
    }).join('\n\n');

    return `${header}\n\n${details}\n\nDuration: ${result.duration_ms}ms | Scanned: ${result.scanned_length} chars`;
}

/**
 * Generate a structured audit log entry for a DLP event.
 */
export function createDLPAuditEntry(
    result: InputValidationResult,
    metadata: {
        agent: string;
        timestamp?: string;
        userId?: string;
    }
): Record<string, unknown> {
    return {
        type: 'dlp_event',
        timestamp: metadata.timestamp ?? new Date().toISOString(),
        agent: metadata.agent,
        userId: metadata.userId,
        status: result.status,
        scanned_length: result.scanned_length,
        duration_ms: result.duration_ms,
        detections: result.detections.map(d => ({
            type: d.type,
            severity: d.severity,
            redacted: d.redacted,
            description: d.description,
            compliance: d.compliance,
        })),
    };
}
