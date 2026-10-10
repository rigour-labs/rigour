/**
 * Security Patterns Gate — Vulnerability Pattern Definitions
 *
 * Contains OWASP rule definitions, regex pattern arrays, and
 * language-specific vulnerability patterns.
 */

/**
 * What the agent is told to do about each kind of finding: every pattern type has its own, and a type without one gets
 * FIX_UNKNOWN, never another type's advice (a hard-coded key told to "parameterize" its query fixes nothing).
 */
export const FIX_BY_TYPE: Record<string, string> = {
    hardcoded_secrets: 'Remove the secret from the code and read it from an environment variable or a secrets manager. Rotate the key: it is in the repository history now.',
    sql_injection: 'Pass the values as query parameters (placeholders or a query builder), never by joining strings into the SQL.',
    xss: 'Render the value as text (textContent, the framework\'s escaping) or sanitize it with an allow-list sanitizer before inserting HTML.',
    path_traversal: 'Resolve the path against a fixed base directory and reject it unless it stays inside that base; never pass user input to the file system as is.',
    command_injection: 'Run the program with an argument list (execFile, spawn without a shell), never a command string built from input.',
    insecure_randomness: 'Use a cryptographic random source (crypto.randomUUID, crypto.getRandomValues, secrets) for tokens, ids and keys.',
    redos: 'Rewrite the expression without nested or overlapping quantifiers, or bound the input length before matching.',
    overly_permissive: 'Restrict it to the origins, hosts or permissions that need it instead of a wildcard.',
    unsafe_output: 'Do not send internal details (stack traces, raw errors, secrets) to the client; log them on the server and return a generic message.',
    missing_input_validation: 'Validate the input against a schema (type, length, range) before using it.',
};

export const FIX_UNKNOWN = 'Review this against the cited CWE and fix the root cause.';

export const VULNERABILITY_PATTERNS: {
    type: string;
    regex: RegExp;
    severity: 'critical' | 'high' | 'medium' | 'low';
    description: string;
    cwe: string;
    languages: string[];
    /**
     * `anywhere` for a pattern about a string's contents (a secret in a literal, a header value, a template): it matches
     * inside strings. Every other pattern is an API used as a call or a statement, and counts only when its match starts
     * in code, not in a string literal or a comment (utils/code-mask.ts).
     */
    where?: 'anywhere';
    /**
     * A credential in a format only a real secret has (a provider's key prefix and length, a private key block): the
     * match is the fact, so it blocks. Every other pattern guesses at input it cannot trace (is it trusted? constant?):
     * likely, shown, never a block unless the team opts in (security.block).
     */
    proven?: true;
}[] = [
    // SQL Injection
    {
        type: 'sql_injection',
        regex: /(?:execute|query|raw|exec)\s*\(\s*`[^`]*(?:SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|WITH)[^`]*\$\{[^}]+\}[^`]*`/gi,
        severity: 'critical',
        description: 'Potential SQL injection: User input concatenated into SQL query',
        cwe: 'CWE-89',
        languages: ['ts', 'js', 'py']
    },
    {
        type: 'sql_injection',
        regex: /(?:execute|query|raw|exec)\s*\(\s*['"`][^'"`]*(?:SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|WITH)[^'"`]*['"`]\s*\+\s*[^)]+\)/gi,
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
        // A secret literal has no whitespace: `hidePassword: 'Hide password'` is a UI label, not a credential.
        regex: /(?:password|secret|api_key|apikey|auth_token|access_token|private_key)['"]?\s*[:=]\s*['"][^'"\s]{8,}['"]/gi, // a key may be quoted: JSON, a Python dict, a JS object
        where: 'anywhere',
        severity: 'critical',
        description: 'Hardcoded secret detected in code',
        cwe: 'CWE-798',
        languages: ['ts', 'js', 'py', 'java', 'go']
    },
    {
        type: 'hardcoded_secrets',
        regex: /(?:sk-|pk-|rk-|ghp_|gho_|ghu_|ghs_|ghr_)[a-zA-Z0-9]{20,}/g,
        where: 'anywhere',
        proven: true,
        severity: 'critical',
        description: 'API key pattern detected (OpenAI, GitHub, etc.)',
        cwe: 'CWE-798',
        languages: ['*']
    },
    {
        type: 'hardcoded_secrets',
        regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
        where: 'anywhere',
        proven: true,
        severity: 'critical',
        description: 'Private key embedded in source code',
        cwe: 'CWE-798',
        languages: ['*']
    },
    {
        type: 'hardcoded_secrets',
        // An AWS access key id, or a Stripe live secret or restricted key: formats only a real credential has.
        regex: /\b(?:AKIA[0-9A-Z]{16}|(?:sk|rk)_live_[0-9a-zA-Z]{24,})\b/g,
        where: 'anywhere',
        proven: true,
        severity: 'critical',
        description: 'Cloud or payment provider key (AWS access key, Stripe live key)',
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
    // JavaScript shell calls are checked with receiver-aware syntax analysis.
    // Python subprocess command injection
    {
        type: 'command_injection',
        regex: /subprocess\.(?:run|call|Popen|check_output|check_call)\s*\([^)]*shell\s*=\s*True/g,
        severity: 'critical',
        description: 'Python subprocess with shell=True — potential command injection',
        cwe: 'CWE-78',
        languages: ['py']
    },
    {
        type: 'command_injection',
        regex: /subprocess\.(?:run|call|Popen|check_output|check_call)\s*\(\s*f["'][^"']*\{[^}]+\}/g,
        severity: 'critical',
        description: 'Python subprocess with f-string interpolation — potential command injection',
        cwe: 'CWE-78',
        languages: ['py']
    },
    {
        type: 'command_injection',
        regex: /os\.(?:system|popen)\s*\(\s*(?:f["']|[^"']*\.format\(|[^"']*%\s)/g,
        severity: 'critical',
        description: 'Python os.system/os.popen with dynamic string — command injection risk',
        cwe: 'CWE-78',
        languages: ['py']
    },
    // ReDoS — Denial of Service via regex (OWASP #7)
    {
        type: 'redos',
        // Request data, or a first argument that is exactly an input name; not any argument that merely contains "user" or "query".
        regex: /new RegExp\s*\(\s*(?:[^)]*\b(?:req|request)\.(?:query|params|body)\b|(?:userInput|input|searchTerm|search|query|term|keyword|pattern)\s*[,)])/g,
        severity: 'high',
        description: 'Dynamic regex from user input — potential ReDoS',
        cwe: 'CWE-1333',
        languages: ['ts', 'js']
    },
    {
        type: 'redos',
        regex: /\(\?:[^)]*\+[^)]*\)\+|\([^)]*\*[^)]*\)\+|\(\.\*\)\{/g,
        where: 'anywhere',
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
        where: 'anywhere',
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
        where: 'anywhere',
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
