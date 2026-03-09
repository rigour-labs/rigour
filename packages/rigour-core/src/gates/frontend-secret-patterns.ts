/**
 * Frontend Secret Exposure Gate — Environment Variable and Literal Key Patterns
 *
 * Contains environment variable pattern definitions, framework-specific env patterns
 * (Next.js, Vite, SvelteKit, etc.), and literal API key detection patterns.
 */

/**
 * Literal API key patterns — actual values that are always dangerous in frontend code.
 * These bypass the env-name heuristic and fire regardless of variable naming.
 */
export const LITERAL_KEY_PATTERNS: {
    label: string;
    regex: RegExp;
    severity: 'critical' | 'high';
    hint: string;
    cwe: string;
}[] = [
    {
        label: 'Stripe Live Secret Key',
        regex: /\bsk_live_[a-zA-Z0-9]{24,}\b/g,
        severity: 'critical',
        hint: 'Live Stripe secret key (sk_live_...) exposed in client bundle. ' +
              'Attackers can charge cards without a frontend. Move to server-side only.',
        cwe: 'CWE-312',
    },
    {
        label: 'Stripe Live Restricted Key',
        regex: /\brk_live_[a-zA-Z0-9]{24,}\b/g,
        severity: 'critical',
        hint: 'Live Stripe restricted key (rk_live_...) must never appear in frontend code.',
        cwe: 'CWE-312',
    },
    {
        label: 'OpenAI API Key',
        regex: /\bsk-proj-[a-zA-Z0-9_-]{40,}\b/g,
        severity: 'critical',
        hint: 'OpenAI project API key (sk-proj-...) exposed in client bundle. ' +
              'Attackers can make unlimited API calls at your expense.',
        cwe: 'CWE-312',
    },
    {
        label: 'OpenAI Legacy API Key',
        regex: /\bsk-[a-zA-Z0-9]{48,}\b/g,
        severity: 'critical',
        hint: 'OpenAI API key (sk-...) exposed in client bundle. Move to server-side proxy.',
        cwe: 'CWE-312',
    },
    {
        label: 'AWS Access Key ID',
        regex: /\bAKIA[A-Z2-7]{16}\b/g,
        severity: 'critical',
        hint: 'AWS Access Key ID exposed in client bundle. This grants AWS API access.',
        cwe: 'CWE-312',
    },
    {
        label: 'GitHub Personal Access Token',
        regex: /\bghp_[a-zA-Z0-9]{36,}\b/g,
        severity: 'critical',
        hint: 'GitHub PAT (ghp_...) in frontend code. Grants repo access to anyone who views bundle.',
        cwe: 'CWE-312',
    },
    {
        label: 'GitHub Fine-Grained PAT',
        regex: /\bgithub_pat_[a-zA-Z0-9_]{55,}\b/g,
        severity: 'critical',
        hint: 'GitHub fine-grained PAT (github_pat_...) must never appear in frontend code.',
        cwe: 'CWE-312',
    },
    {
        label: 'Anthropic API Key',
        regex: /\bsk-ant-api\d{2}-[a-zA-Z0-9_-]{90,}\b/g,
        severity: 'critical',
        hint: 'Anthropic API key exposed in client bundle. Move to a server-side proxy.',
        cwe: 'CWE-312',
    },
    {
        label: 'SendGrid API Key',
        regex: /\bSG\.[a-zA-Z0-9_-]{22,}\.[a-zA-Z0-9_-]{43,}\b/g,
        severity: 'critical',
        hint: 'SendGrid API key exposed in client bundle. Attackers can send spam as you.',
        cwe: 'CWE-312',
    },
];

/** Severity ordering for threshold comparison */
export const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 } as const;

/**
 * Extracts the env var name from a single-reference line.
 */
export function extractEnvVarName(
    line: string,
    checkProcessEnv: boolean,
    checkImportMetaEnv: boolean,
): string | null {
    if (checkProcessEnv) {
        const dot = line.match(/process\.env\.([A-Z][A-Z0-9_]*)/);
        if (dot) return dot[1];
        const bracket = line.match(/process\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]/);
        if (bracket) return bracket[1];
    }
    if (checkImportMetaEnv) {
        const vite = line.match(/import\.meta\.env\.([A-Z_][A-Z0-9_]*)/);
        if (vite) return vite[1];
    }
    const sveltePrivate = line.match(/import\s+\{([^}]+)\}\s+from\s+['"]?\$env\/(?:static|dynamic)\/private['"]?/);
    if (sveltePrivate) {
        const firstVar = sveltePrivate[1].split(',')[0].trim();
        if (/^[A-Z_][A-Z0-9_]*$/.test(firstVar)) return firstVar;
    }
    return null;
}

/**
 * Finds all var names from destructuring:
 * const { STRIPE_SECRET_KEY, OPENAI_KEY } = process.env
 */
export function extractDestructuredEnvVars(line: string): string[] {
    if (!/=\s*process\.env\b/.test(line)) return [];
    const brace = line.match(/\{\s*([^}]+)\s*\}/);
    if (!brace) return [];
    return brace[1]
        .split(',')
        .map(s => s.split(':')[0].trim())
        .filter(s => /^[A-Z_][A-Z0-9_]*$/.test(s));
}
