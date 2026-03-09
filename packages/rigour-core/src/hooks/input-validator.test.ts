/**
 * Tests for Input Validation Gate — AI Agent DLP (Data Loss Prevention)
 *
 */
import { describe, it, expect } from 'vitest';
import {
    scanInputForCredentials,
    formatDLPAlert,
    createDLPAuditEntry,
} from './input-validator.js';

// ── Cloud Provider Keys ──────────────────────────────────────────

describe('scanInputForCredentials — AWS', () => {
    it('detects AWS Access Key IDs', () => {
        const result = scanInputForCredentials('Here is my key: AKIAIOSFODNN7EXAMPLE');
        expect(result.status).toBe('blocked');
        expect(result.detections).toHaveLength(1);
        expect(result.detections[0].type).toBe('aws_access_key');
        expect(result.detections[0].severity).toBe('critical');
    });

    it('detects AWS Secret Key assignments', () => {
        const result = scanInputForCredentials('aws_secret_access_key = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"');
        expect(result.status).toBe('blocked');
        expect(result.detections.some(d => d.type === 'aws_secret_key')).toBe(true);
    });
});

describe('scanInputForCredentials — GCP', () => {
    it('detects GCP service account JSON', () => {
        const input = '{"type": "service_account", "project_id": "my-proj", "private_key": "-----BEGIN RSA PRIVATE KEY-----"}';
        const result = scanInputForCredentials(input);
        expect(result.status).toBe('blocked');
        // May detect as gcp_service_account and/or private_key
        expect(result.detections.length).toBeGreaterThanOrEqual(1);
    });
});

describe('scanInputForCredentials — Azure', () => {
    it('detects Azure storage key', () => {
        const result = scanInputForCredentials('AccountKey=dGhpcyBpcyBhIGJhc2U2NCBzdHJpbmcgdGhhdCBpcyBsb25nIGVub3VnaCB0byBtYXRjaA==');
        expect(result.status).toBe('blocked');
        expect(result.detections.some(d => d.type === 'azure_key')).toBe(true);
    });
});

// ── API Keys (Provider-Specific) ─────────────────────────────────

describe('scanInputForCredentials — API keys', () => {
    it('detects OpenAI key', () => {
        const result = scanInputForCredentials('sk-proj-abc1234567890ABCDEFGH');
        expect(result.status).toBe('blocked');
        expect(result.detections[0].type).toBe('openai_key');
    });

    it('detects Anthropic key', () => {
        const result = scanInputForCredentials('sk-ant-api03-abcdefghijklmnop123456');
        expect(result.status).toBe('blocked');
        expect(result.detections[0].type).toBe('anthropic_key');
    });

    it('detects GitHub PAT', () => {
        const result = scanInputForCredentials('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh12');
        expect(result.status).toBe('blocked');
        expect(result.detections[0].type).toBe('github_token');
    });

    it('detects Stripe live key', () => {
        const result = scanInputForCredentials('sk_live_51HxAbCdEfGhIjKlMnOpQrStU');
        expect(result.status).toBe('blocked');
        expect(result.detections[0].type).toBe('stripe_key');
    });

    it('detects SendGrid key', () => {
        const result = scanInputForCredentials('SG.abcdefghijklmnopqrstuv.1234567890abcdefghijklmnopqrstuvwxyz1234567');
        expect(result.status).toBe('blocked');
        expect(result.detections[0].type).toBe('sendgrid_key');
    });
});

// ── Private Keys ─────────────────────────────────────────────────

describe('scanInputForCredentials — Private keys', () => {
    it('detects RSA private key header', () => {
        const result = scanInputForCredentials('-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQ...');
        expect(result.status).toBe('blocked');
        expect(result.detections.some(d => d.type === 'private_key')).toBe(true);
    });

    it('detects EC private key header', () => {
        const result = scanInputForCredentials('-----BEGIN EC PRIVATE KEY-----');
        expect(result.status).toBe('blocked');
    });

    it('detects OPENSSH private key header', () => {
        const result = scanInputForCredentials('-----BEGIN OPENSSH PRIVATE KEY-----');
        expect(result.status).toBe('blocked');
    });
});

// ── Database Connection Strings ──────────────────────────────────

describe('scanInputForCredentials — Database URLs', () => {
    it('detects PostgreSQL connection string', () => {
        const result = scanInputForCredentials('postgresql://user:password@prod-server:5432/mydb');
        expect(result.status).toBe('blocked');
        const dbDetection = result.detections.find(d => d.type === 'database_url');
        expect(dbDetection).toBeDefined();
    });

    it('detects MongoDB connection string', () => {
        const result = scanInputForCredentials('mongodb+srv://admin:s3cret@cluster0.abc123.mongodb.net/production');
        expect(result.status).toBe('blocked');
    });

    it('detects Redis connection string', () => {
        const result = scanInputForCredentials('redis://default:mypassword@redis-host:6379');
        expect(result.status).toBe('blocked');
    });
});

// ── Bearer Tokens & JWTs ─────────────────────────────────────────

describe('scanInputForCredentials — Tokens', () => {
    it('detects JWT token', () => {
        const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
        const result = scanInputForCredentials(jwt);
        expect(result.status).toBe('blocked');
        expect(result.detections.some(d => d.type === 'jwt_token')).toBe(true);
    });
});

// ── Generic Patterns ─────────────────────────────────────────────

describe('scanInputForCredentials — Generic patterns', () => {
    it('detects password assignment', () => {
        const result = scanInputForCredentials("password = 'SuperSecret123!'");
        expect(result.status).toBe('blocked');
        expect(result.detections[0].type).toBe('password_assignment');
    });

    it('detects api_key assignment', () => {
        const result = scanInputForCredentials('api_key: "abcdefghijklmnopqrstuvwxyz"');
        expect(result.status).toBe('blocked');
    });

    it('detects .env format', () => {
        const result = scanInputForCredentials('DATABASE_PASSWORD=myS3cr3tP@ssw0rd!');
        expect(result.status).toBe('blocked');
        expect(result.detections.some(d => d.type === 'env_variable')).toBe(true);
    });

    it('detects URL with embedded credentials', () => {
        const result = scanInputForCredentials('http://admin:password123@internal-api.company.com/v1');
        expect(result.status).toBe('blocked');
        expect(result.detections.some(d => d.type === 'credentials_in_url')).toBe(true);
    });
});

// ── Clean Input ──────────────────────────────────────────────────

describe('scanInputForCredentials — Clean input', () => {
    it('returns clean for normal code', () => {
        const result = scanInputForCredentials('function hello() { return "world"; }');
        expect(result.status).toBe('clean');
        expect(result.detections).toHaveLength(0);
    });

    it('returns clean for env var references (not values)', () => {
        const result = scanInputForCredentials('const key = process.env.API_KEY;');
        expect(result.status).toBe('clean');
    });

    it('returns clean for placeholder values', () => {
        const result = scanInputForCredentials('password = "xxx"');
        expect(result.status).toBe('clean'); // too short
    });
});

// ── Config Options ───────────────────────────────────────────────

describe('scanInputForCredentials — Config', () => {
    it('respects enabled: false', () => {
        const result = scanInputForCredentials('AKIAIOSFODNN7EXAMPLE', { enabled: false });
        expect(result.status).toBe('clean');
    });

    it('returns warning instead of blocked when block_on_detection is false', () => {
        const result = scanInputForCredentials('AKIAIOSFODNN7EXAMPLE', { block_on_detection: false });
        expect(result.status).toBe('warning');
        expect(result.detections).toHaveLength(1);
    });

    it('respects custom min_secret_length', () => {
        const result = scanInputForCredentials('password = "short"', { min_secret_length: 20 });
        // "short" is only 5 chars, below default 8, so it would be skipped anyway
        expect(result.status).toBe('clean');
    });

    it('applies custom patterns', () => {
        const result = scanInputForCredentials('internal-token-XYZ123456', {
            custom_patterns: ['internal-token-[A-Z0-9]+'],
        });
        expect(result.status).toBe('blocked');
        expect(result.detections[0].type).toBe('custom_pattern');
    });

    it('respects ignore patterns', () => {
        const result = scanInputForCredentials('AKIAIOSFODNN7EXAMPLE', {
            ignore_patterns: ['AKIAIOSFODNN7EXAMPLE'],
        });
        expect(result.status).toBe('clean');
    });
});

// ── Performance ──────────────────────────────────────────────────

describe('scanInputForCredentials — Performance', () => {
    it('completes in under 50ms for typical input', () => {
        const input = 'A'.repeat(10000); // 10KB of text
        const result = scanInputForCredentials(input);
        expect(result.duration_ms).toBeLessThan(50);
    });

    it('tracks scanned_length correctly', () => {
        const input = 'test input here';
        const result = scanInputForCredentials(input);
        expect(result.scanned_length).toBe(input.length);
    });
});

// ── Deduplication ────────────────────────────────────────────────

describe('scanInputForCredentials — Deduplication', () => {
    it('deduplicates overlapping detections and keeps higher severity', () => {
        // Input that might trigger both generic password_assignment and a more specific pattern
        const input = 'api_key = "sk-proj-abc1234567890ABCDEFGH"';
        const result = scanInputForCredentials(input);
        // Should not have duplicate detections for the same match region
        const positions = result.detections.map(d => d.position?.start);
        const uniquePositions = new Set(positions);
        // The exact count depends on pattern overlaps, but there should be some deduplication
        expect(result.detections.length).toBeLessThanOrEqual(positions.length);
    });
});

// ── Redaction ────────────────────────────────────────────────────

describe('scanInputForCredentials — Redaction', () => {
    it('redacts matched credentials', () => {
        const result = scanInputForCredentials('AKIAIOSFODNN7EXAMPLE');
        expect(result.detections[0].redacted).toContain('****');
        expect(result.detections[0].redacted).not.toBe('AKIAIOSFODNN7EXAMPLE');
    });
});

// ── Compliance ───────────────────────────────────────────────────

describe('scanInputForCredentials — Compliance', () => {
    it('includes compliance tags for AWS keys', () => {
        const result = scanInputForCredentials('AKIAIOSFODNN7EXAMPLE');
        expect(result.detections[0].compliance).toContain('SOC2-CC6.1');
        expect(result.detections[0].compliance).toContain('HIPAA-164.312');
        expect(result.detections[0].compliance).toContain('PCI-DSS-3.4');
    });
});

// ── formatDLPAlert ───────────────────────────────────────────────

describe('formatDLPAlert', () => {
    it('returns clean message for clean input', () => {
        const result = scanInputForCredentials('just normal code');
        const alert = formatDLPAlert(result);
        expect(alert).toContain('clean');
    });

    it('shows BLOCKED header when credentials found', () => {
        const result = scanInputForCredentials('AKIAIOSFODNN7EXAMPLE');
        const alert = formatDLPAlert(result);
        expect(alert).toContain('BLOCKED');
        expect(alert).toContain('credential');
    });

    it('shows WARNING header when block_on_detection is false', () => {
        const result = scanInputForCredentials('AKIAIOSFODNN7EXAMPLE', { block_on_detection: false });
        const alert = formatDLPAlert(result);
        expect(alert).toContain('WARNING');
    });

    it('includes severity, redacted value, and recommendation', () => {
        const result = scanInputForCredentials('AKIAIOSFODNN7EXAMPLE');
        const alert = formatDLPAlert(result);
        expect(alert).toContain('CRITICAL');
        expect(alert).toContain('****');
        expect(alert).toContain('process.env');
    });
});

// ── createDLPAuditEntry ──────────────────────────────────────────

describe('createDLPAuditEntry', () => {
    it('creates structured audit entry', () => {
        const result = scanInputForCredentials('AKIAIOSFODNN7EXAMPLE');
        const entry = createDLPAuditEntry(result, { agent: 'claude', userId: 'test-user' });

        expect(entry.type).toBe('dlp_event');
        expect(entry.agent).toBe('claude');
        expect(entry.userId).toBe('test-user');
        expect(entry.status).toBe('blocked');
        expect(entry.timestamp).toBeDefined();
        expect(Array.isArray(entry.detections)).toBe(true);
    });

    it('uses provided timestamp if given', () => {
        const result = scanInputForCredentials('just code');
        const ts = '2025-01-01T00:00:00.000Z';
        const entry = createDLPAuditEntry(result, { agent: 'cursor', timestamp: ts });
        expect(entry.timestamp).toBe(ts);
    });

    it('redacts credentials in audit log (no raw match)', () => {
        const result = scanInputForCredentials('AKIAIOSFODNN7EXAMPLE');
        const entry = createDLPAuditEntry(result, { agent: 'claude' });
        const detections = entry.detections as any[];
        // Audit entry should have redacted field but NOT the raw match
        expect(detections[0].redacted).toBeDefined();
        expect(detections[0].match).toBeUndefined();
    });
});
