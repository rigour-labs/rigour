import { describe, expect, it } from 'vitest';
import { validateTeamDatabaseUrl } from './team-store.js';

describe('team database configuration', () => {
    it('requires TLS for remote PostgreSQL URLs', () => {
        expect(() => validateTeamDatabaseUrl('postgresql://user:pass@db.example.com/rigour')).toThrow(/sslmode/);
        expect(() => validateTeamDatabaseUrl('postgresql://user:pass@db.example.com/rigour?sslmode=verify-full')).not.toThrow();
    });

    it('rejects non-PostgreSQL URLs', () => {
        expect(() => validateTeamDatabaseUrl('mysql://localhost/rigour')).toThrow(/postgres/);
    });
});
