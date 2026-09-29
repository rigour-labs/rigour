/**
 * Turns team-database failures into messages that say what to do.
 *
 * `team doctor` used to throw "Database role is not provisioned for this
 * team" whenever the membership query returned no row, including when the
 * role was provisioned but row-level security hid it, and let connection
 * errors escape as stack traces.
 */

export interface QueryablePool {
    query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

const UNTRUSTED_CERTIFICATE = new Set([
    'SELF_SIGNED_CERT_IN_CHAIN',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
]);

/** A connection or query error, explained with the fix. */
export function explainTeamConnectionError(error: unknown): string {
    const err = error as { code?: string; message?: string };
    const code = err?.code ?? '';
    const detail = err?.message ?? String(error);
    if (UNTRUSTED_CERTIFICATE.has(code)) {
        return `TLS: the database certificate chain is not trusted by Node (${code}). Managed hosts such as Supabase sign `
            + `with their own root CA: download it from the provider, set NODE_EXTRA_CA_CERTS=<path to the CA file>, and keep sslmode=verify-full.`;
    }
    if (code === 'ENOTFOUND' || code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'EHOSTUNREACH') {
        return `Cannot reach the team database (${code}): check the host, port and network access. ${detail}`;
    }
    if (code === '28P01' || code === '28000') {
        return `The database rejected the login (${code}): check the user and password in the team database URL.`;
    }
    if (code === '3F000' || code === '42P01') {
        return `The team schema is missing (${code}): run \`rigour team init-schema\` with the administrator URL.`;
    }
    return detail;
}

/**
 * Why the membership query returned no row: RLS without a policy for this
 * login, or no membership row for it. Visibility is read from the catalog,
 * which every login can see.
 */
export async function diagnoseMissingMembership(pool: QueryablePool): Promise<string> {
    let hidden: string[] = [];
    try {
        const result = await pool.query(
            `SELECT c.relname AS table_name
               FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'rigour' AND c.relname IN ('memberships', 'meta') AND c.relrowsecurity
                AND NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'rigour' AND p.tablename = c.relname)`,
        );
        hidden = result.rows.map(row => String(row.table_name));
    } catch {
        // Catalog not readable: fall back to the provisioning message.
    }
    if (hidden.length > 0) {
        return `Row-level security is enabled on ${hidden.map(t => `rigour.${t}`).join(' and ')} with no policy, so this login `
            + `cannot see its membership. Run \`rigour team init-schema\` with the administrator URL to add the read policies.`;
    }
    return 'This database role has no membership for the configured organization, team and actor. '
        + 'Ask the administrator to add it (see docs/ENTERPRISE.md).';
}
