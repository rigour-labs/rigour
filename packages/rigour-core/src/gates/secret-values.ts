/**
 * Whether a value written under a secret-named key (`password = "…"`, `DB_PASSWORD=…`) could be a real secret. One
 * answer for the review's security check and the credential scan before an agent's tool call, so both stay quiet on
 * the same placeholders, references and test values.
 */

/** The value of a `key = value` / `key: value` match: quoted, else an unquoted `.env` value; undefined when neither. */
export function secretValueOf(matchText: string): string | undefined {
    const quoted = matchText.match(/[:=]\s*['"]([^'"]*)['"]/);
    if (quoted) return quoted[1];
    const bare = matchText.match(/=[ \t]*([^\s'"#][^\s'"]*)(?:[ \t]+#.*)?[ \t]*$/); // `#` opens a comment only after whitespace
    return bare?.[1];
}

/**
 * True when the value is not a secret anyone would leak: empty, a reference to one kept elsewhere (an environment
 * variable, a template), a placeholder or example, a test value, a name or constant, or too regular to be random.
 */
export function isPlaceholderSecret(value: string): boolean {
    if (!value.trim()) return true;

    // A reference to where the secret lives: $VAR, ${VAR}, {{ var }}, %VAR%, process.env.X / os.environ[...] as text.
    if (/^\$|\$\{|\{\{|^%[A-Z_]+%$|process\.env|os\.environ|getenv/i.test(value)) return true;

    // Placeholder/example patterns
    if (/^(?:your[_-]|my[_-]|example[_-]|placeholder|changeme|replace[_-]me|xxx+|dummy|fake|sample|<.*>$|\*+$)/i.test(value)) return true;

    // Test-specific dummy values
    if (/^(?:test[_-]|e2e[_-]|mock[_-]|stub[_-]|dev[_-])/i.test(value)) return true;
    if (/^testpass(?:word)?$/i.test(value)) return true;

    // All-caps with underscores/dollars = env var names or constants, not actual secrets
    // e.g., API_KEY = "OPEN_SANDBOX_API_KEY", SECRETS$ADD_SECRET (Redux action types)
    if (/^[A-Z][A-Z0-9_$]{7,}$/.test(value)) return true;

    // Store action type patterns: NAMESPACE$ACTION or namespace/ACTION (Redux, Zustand, Flux)
    if (/^\w+\$\w+$/.test(value)) return true;
    if (/^[a-z][\w-]*\/[A-Z_]+$/.test(value)) return true;

    // Common documentation/tutorial dummy values
    if (/^(?:sk_test_|pk_test_|sk_live_xxx|password123|secret123|abcdef|abc123)/i.test(value)) return true;

    // Shannon entropy check: low-entropy values are likely constants, not real secrets
    // Real secrets have high entropy (>4.0 bits/char); constants and names have low entropy
    if (shannonEntropy(value) < 3.0) return true;

    // ALL_CAPS_SNAKE_CASE without any lowercase/special chars = likely enum or constant
    if (/^[A-Z][A-Z0-9_$]*$/.test(value) && value.length >= 6) return true;

    // URL-like values that are just config (not secrets): localhost, 127.0.0.1, etc., with or without user:pass@ for a local service.
    if (/^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0)/.test(value)) return true;
    if (/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/\s]*@)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?:[:/]|$)/i.test(value)) return true;

    // Common non-secret patterns: UUIDs, semver
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return true;
    if (/^\d+\.\d+\.\d+/.test(value)) return true; // semver

    return false;
}

/** The names of a secret, by their words: `api_key`, `apiKey`, `ApiKey`, `apikey` and `API_KEY` are all `api key`. */
const SECRET_KEY_WORDS = ['password', 'passwd', 'pwd', 'secret', 'api key', 'api token', 'auth token', 'access token', 'refresh token',
    'client secret', 'private key', 'signing key', 'encryption key'].map(name => name.split(' '));

/** Each later word joined by an optional `_`/`-`, its first letter either case: `[_-]?[Kk]ey`. */
const laterWords = (words: string[]) => words.slice(1).map(w => `[_-]?[${w[0].toUpperCase()}${w[0]}]${w.slice(1)}`).join('');
const either = (forms: string[]) => `(?:${forms.join('|')})`;
const LOWER = either(SECRET_KEY_WORDS.map(words => words[0] + laterWords(words)));
const CAPITAL = either(SECRET_KEY_WORDS.map(words => words[0][0].toUpperCase() + words[0].slice(1) + laterWords(words)));
const UPPER = either(SECRET_KEY_WORDS.map(words => words.map(w => w.toUpperCase()).join('[_-]?')));

/**
 * A key that ends in a secret's name, as a regular expression's source. The name starts a word or follows a `_`/`-`
 * (`password`, `db_password`, `DB_PASSWORD`, `privateKey`), or starts at a lower-to-upper-case step (`dbPassword`,
 * `getAccessToken`). Case-sensitive on purpose, so a name inside a longer word never counts. The caller decides
 * what may follow the name; `passwordless`, `secretary` and `tokenizer` are never keys.
 */
export const SECRET_KEY_SOURCE = `(?:\\b(?:[A-Za-z0-9]+[_-])*${either([LOWER, CAPITAL, UPPER])}|\\b[A-Za-z0-9]+${CAPITAL})`;

const SECRET_KEY_NAME = new RegExp(`${SECRET_KEY_SOURCE}(?![A-Za-z])`);

/** Whether a key names a secret: password, secret, an API key or token, an auth, access or refresh token, a client secret, a private, signing or encryption key. */
export function isSecretKeyName(key: string): boolean {
    return SECRET_KEY_NAME.test(key);
}

/** Shannon entropy (bits per character): real secrets are high (>4.5), constants and names low (<3.0). */
function shannonEntropy(str: string): number {
    if (!str) return 0;
    const freq = new Map<string, number>();
    for (const ch of str) freq.set(ch, (freq.get(ch) || 0) + 1);
    let entropy = 0;
    for (const count of freq.values()) {
        const p = count / str.length;
        entropy -= p * Math.log2(p);
    }
    return entropy;
}
