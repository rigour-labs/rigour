export type DLPDecision = 'block' | 'warn' | 'allow';

interface DLPDetectionInput {
    type: string;
    match: string;
    position?: { start: number; end: number };
}

interface DLPClassification {
    confidence: number;
    decision: DLPDecision;
    reason_codes: string[];
}

const UNCONDITIONAL_BLOCK_TYPES = new Set([
    'private_key',
    'private_key_full',
    'gcp_service_account',
    'bearer_token',
    'jwt_token',
]);

const PROVIDER_BLOCK_TYPES = new Set([
    'aws_secret_key',
    'azure_key',
    'anthropic_key',
    'slack_token',
    'sendgrid_key',
]);

const PROVIDER_TYPES = new Set([
    'aws_access_key',
    'openai_key',
    'github_token',
    'stripe_key',
    'twilio_key',
]);

const GENERIC_TYPES = new Set([
    'password_assignment',
    'env_variable',
    'ci_secret',
    'base64_secret',
    'hex_secret',
    'high_entropy_secret',
    'custom_pattern',
]);

export function classifyDLPDetection(detection: DLPDetectionInput, input: string): DLPClassification {
    const context = getDetectionContext(detection, input);
    const value = extractDetectionValue(detection);
    const reasons = new Set<string>();

    if (UNCONDITIONAL_BLOCK_TYPES.has(detection.type)) {
        reasons.add('sensitive_secret_type');
        return verdict(98, 'block', reasons);
    }

    if (isCommentLine(context.line) && !UNCONDITIONAL_BLOCK_TYPES.has(detection.type)) {
        reasons.add('comment_context');
        return verdict(15, 'allow', reasons);
    }

    const safe = safeValueVerdict(detection, value, context, reasons);
    if (safe) return safe;

    if (GENERIC_TYPES.has(detection.type)) {
        return classifyGenericSecret(detection, value, context, reasons);
    }

    let confidence = baseConfidence(detection.type);
    addPositiveSignals(detection, value, reasons);
    addContextSignals(context, value, reasons);
    confidence += confidenceAdjustment(reasons);

    const contextual = contextualAllowVerdict(detection, value, context, confidence, reasons);
    if (contextual) return contextual;

    if (PROVIDER_BLOCK_TYPES.has(detection.type)) {
        return verdict(confidence, confidence >= 80 ? 'block' : 'warn', reasons);
    }

    if (PROVIDER_TYPES.has(detection.type)) {
        if (isDocumentationContext(context.before, context.line) && !isHighEntropy(value)) {
            reasons.add('docs_context');
            return verdict(25, 'allow', reasons);
        }
        return verdict(confidence, confidence >= 80 ? 'block' : 'warn', reasons);
    }

    if (detection.type === 'database_url' || detection.type === 'credentials_in_url') {
        if (isLocalDatabaseUrl(value) || isLocalDatabaseUrl(context.line)) {
            reasons.add('localhost_only');
            return verdict(22, 'allow', reasons);
        }
        return verdict(confidence, confidence >= 80 ? 'block' : 'warn', reasons);
    }

    return verdict(confidence, confidence >= 80 ? 'block' : 'warn', reasons);
}

function classifyGenericSecret(
    detection: DLPDetectionInput,
    value: string,
    context: { line: string; before: string },
    reasons: Set<string>
): DLPClassification {
    if (detection.type === 'custom_pattern') {
        reasons.add('secret_assignment');
        return verdict(55, 'warn', reasons);
    }
    if (isSafePlaceholder(detection.type, value, context)) {
        reasons.add('safe_example_value');
        return verdict(18, 'allow', reasons);
    }
    if (isSafeContext(context, value)) {
        reasons.add('safe_context');
        return verdict(25, 'allow', reasons);
    }
    if (isHighEntropy(value) && value.length >= 24) {
        reasons.add('high_entropy');
        reasons.add('secret_assignment');
        return verdict(72, 'warn', reasons);
    }
    reasons.add('secret_assignment');
    return verdict(25, 'allow', reasons);
}

function safeValueVerdict(
    detection: DLPDetectionInput,
    value: string,
    context: { line: string; before: string },
    reasons: Set<string>
): DLPClassification | undefined {
    if (isEnvReference(value) || isHashLine(context.line)) {
        reasons.add('safe_reference_value');
        return verdict(18, 'allow', reasons);
    }
    if (isSafePlaceholder(detection.type, value, context)) {
        reasons.add('safe_example_value');
        return verdict(18, 'allow', reasons);
    }
    if (isPublicOrDevCredential(detection.type, value, context)) {
        reasons.add('public_or_test_key');
        return verdict(18, 'allow', reasons);
    }
    if (isLivePublishableStripeKey(detection.type, value)) {
        reasons.add('public_live_key');
        return verdict(45, 'warn', reasons);
    }
}

function contextualAllowVerdict(
    detection: DLPDetectionInput,
    value: string,
    context: { line: string; before: string },
    confidence: number,
    reasons: Set<string>
): DLPClassification | undefined {
    if (isSafeContext(context, value) && !isHighEntropySecret(detection.type, value)) {
        reasons.add('safe_context');
        return verdict(Math.min(confidence, 30), 'allow', reasons);
    }
    return commandOrLocalVerdict(detection, value, context, reasons);
}

function commandOrLocalVerdict(
    detection: DLPDetectionInput,
    value: string,
    context: { line: string },
    reasons: Set<string>
): DLPClassification | undefined {
    if (detection.type === 'ssh_credentials' && !hasSensitiveSshOptions(context.line)) {
        reasons.add('ssh_alias_or_host');
        return verdict(25, 'allow', reasons);
    }
    if (isLocalDatabaseUrl(value) || isLocalDatabaseUrl(context.line)) {
        reasons.add('localhost_only');
        return verdict(22, 'allow', reasons);
    }
}

function baseConfidence(type: string): number {
    if (PROVIDER_BLOCK_TYPES.has(type)) return 92;
    if (PROVIDER_TYPES.has(type)) return 78;
    if (GENERIC_TYPES.has(type)) return 40;
    if (type === 'database_url' || type === 'credentials_in_url') return 82;
    if (type === 'ssh_credentials') return 35;
    return 50;
}

function addPositiveSignals(detection: DLPDetectionInput, value: string, reasons: Set<string>): void {
    if (PROVIDER_TYPES.has(detection.type) || PROVIDER_BLOCK_TYPES.has(detection.type)) {
        reasons.add('provider_pattern');
    }
    if (GENERIC_TYPES.has(detection.type)) {
        reasons.add('secret_assignment');
    }
    if (isHighEntropy(value)) {
        reasons.add('high_entropy');
    }
    if (value.length >= 32) {
        reasons.add('long_token');
    }
}

function addContextSignals(context: { line: string; before: string }, value: string, reasons: Set<string>): void {
    if (isDocumentationContext(context.before, context.line)) reasons.add('docs_context');
    if (isCommentLine(context.line)) reasons.add('comment_context');
    if (isBuildLogLine(context.line)) reasons.add('build_log_context');
    if (isSafePlaceholderValue(value)) reasons.add('known_placeholder');
    if (isEnvReference(value)) reasons.add('env_reference');
    if (isHashLine(context.line)) reasons.add('checksum_or_hash');
}

function confidenceAdjustment(reasons: Set<string>): number {
    const weights: Record<string, number> = {
        provider_pattern: 12,
        secret_assignment: 6,
        high_entropy: 16,
        long_token: 6,
        docs_context: -35,
        comment_context: -40,
        build_log_context: -30,
        known_placeholder: -45,
        env_reference: -45,
        checksum_or_hash: -50,
    };

    return [...reasons].reduce((sum, reason) => sum + (weights[reason] ?? 0), 0);
}

function getDetectionContext(detection: DLPDetectionInput, input: string): { line: string; before: string } {
    const start = detection.position?.start ?? 0;
    const end = detection.position?.end ?? detection.match.length;
    const lineStart = input.lastIndexOf('\n', start) + 1;
    const lineEnd = input.indexOf('\n', end);
    const beforeStart = Math.max(0, start - 300);
    return {
        line: input.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim(),
        before: input.slice(beforeStart, start),
    };
}

function extractDetectionValue(detection: DLPDetectionInput): string {
    const assignment = detection.match.match(/[:=]\s*['"]?(.+?)['"]?\s*$/);
    const value = assignment?.[1] ?? detection.match;
    return value.replace(/^['"`]+|['"`;]+$/g, '');
}

function isPublicOrDevCredential(type: string, value: string, context: { line: string; before: string }): boolean {
    if (/^pk_test_/i.test(value)) return true;
    if (!PROVIDER_TYPES.has(type)) return false;
    return isSafeProviderExample(value, context);
}

function isSafeContext(context: { line: string; before: string }, value: string): boolean {
    return isDocumentationContext(context.before, context.line)
        || isBuildLogLine(context.line)
        || isSafePlaceholderValue(value)
        || isEnvReference(value)
        || isHashLine(context.line);
}

function isDocumentationContext(before: string, line: string): boolean {
    const text = before + '\n' + line;
    return /(?:example|sample|placeholder|fake|dummy|test fixture|fixture|docs?|readme|tutorial|settings\.json|cursor\.apiKey|env var|process\.env)/i.test(text);
}

function isCommentLine(line: string): boolean {
    return /^\s*(?:\/\/|#|\*|<!--)/.test(line);
}

function isBuildLogLine(line: string): boolean {
    return /^npm\s+(?:notice|warn|WARN|ERR!)/i.test(line)
        || /^#\d+\s+[\d.]+\s/.test(line)
        || /\b(?:missing|undefined|not set|not found|required)\b/i.test(line);
}

function isHashLine(line: string): boolean {
    return /(?:digest|hash|checksum|sha256|sha1|md5)\s*[:=]/i.test(line);
}

function isSafePlaceholder(type: string, value: string, context: { line: string; before: string }): boolean {
    if (isSafePlaceholderValue(value)) return true;
    if (isPlaceholderCredentialUrl(value) || isPlaceholderCredentialUrl(context.line)) return true;
    if (GENERIC_TYPES.has(type) && isGenericPlaceholderValue(value)) return true;
    return PROVIDER_TYPES.has(type) && isSafeProviderExample(value, context);
}

function isSafePlaceholderValue(value: string): boolean {
    return /^(?:example|placeholder|dummy|fake|sample|changeme|replace[_-]?me|password123|secret123|correct horse battery staple)$/i.test(value)
        || /^(?:your[_-]?)?(?:api[_-]?)?key[_-]?here$/i.test(value)
        || /^not-a-real/i.test(value)
        || /^super-secret-client-id-string$/i.test(value)
        || /^x{8,}$/i.test(value)
        || /^test[_-]/i.test(value)
        || /^dev[_-]/i.test(value)
        || /^mock[_-]/i.test(value)
        || /^stub[_-]/i.test(value)
        || value === 'abcdefghijklmnopqrstuvwxyz'
        || /EXAMPLE(?:KEY)?$/i.test(value);
}

function isGenericPlaceholderValue(value: string): boolean {
    return /(?:example|placeholder|dummy|fake|sample|your[_-]|replace[_-]?me|not-a-real)/i.test(value);
}

function isSafeProviderExample(value: string, context: { line: string; before: string }): boolean {
    return isDocumentationContext(context.before, context.line) && isSafePlaceholderValue(value);
}

function isPlaceholderCredentialUrl(value: string): boolean {
    const match = value.match(/^[a-z][a-z0-9+.-]*:\/\/[^:@/\s]+:([^@/\s]+)@/i);
    return match !== null && isSafePlaceholderValue(decodeURIComponent(match[1]));
}

function isLivePublishableStripeKey(type: string, value: string): boolean {
    return type === 'stripe_key' && /^pk_live_/i.test(value);
}

function isEnvReference(value: string): boolean {
    return /^\$\{?[A-Z][A-Z0-9_]+\}?$/.test(value)
        || /^process\.env\.[A-Z][A-Z0-9_]+$/.test(value);
}

function isHighEntropySecret(type: string, value: string): boolean {
    return type === 'high_entropy_secret' || (value.length >= 24 && isHighEntropy(value));
}

function isHighEntropy(value: string): boolean {
    if (value.length < 24) return false;
    const freq: Record<string, number> = {};
    for (const char of value) freq[char] = (freq[char] || 0) + 1;
    return Object.values(freq).reduce((sum, count) => {
        const probability = count / value.length;
        return sum - probability * Math.log2(probability);
    }, 0) > 4.5;
}

function hasSensitiveSshOptions(line: string): boolean {
    return /\b(?:-i|IdentityFile)\b/.test(line) || /\bpassword\b/i.test(line);
}

function isLocalDatabaseUrl(value: string): boolean {
    const hasDbScheme = /(?:^|=)(?:postgres(?:ql)?|mysql|mariadb|mssql|mongodb(?:\+srv)?|redis|rediss|amqp|amqps):\/\//i.test(value);
    if (!hasDbScheme) return false;
    if (/@(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::|\/|$)/i.test(value)) return true;
    return /:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::|\/|$)/i.test(value);
}

function verdict(confidence: number, decision: DLPDecision, reasons: Set<string>): DLPClassification {
    return {
        confidence: Math.max(0, Math.min(99, Math.round(confidence))),
        decision,
        reason_codes: [...reasons].sort(),
    };
}
