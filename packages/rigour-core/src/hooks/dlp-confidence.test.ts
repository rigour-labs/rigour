import { describe, expect, it } from 'vitest';
import {
    createDLPAuditEntry,
    formatDLPAlert,
    scanInputForCredentials,
} from './input-validator.js';

describe('DLP confidence engine', () => {
    it('allows explicit example password assignments', () => {
        const result = scanInputForCredentials('password = "examplepassword"');
        expect(result.status).toBe('clean');
        expect(result.allowed_detections?.[0].decision).toBe('allow');
    });

    it('warns on high-entropy values even with api_key label', () => {
        const result = scanInputForCredentials('api_key: "abcdefZ9y8X7w6V5u4T3s2R1q0P9o8N7m6"');
        expect(result.status).toBe('warning');
        expect(result.detections[0].decision).toBe('warn');
    });

    it('allows localhost database URLs with placeholder credentials', () => {
        const result = scanInputForCredentials('DATABASE_URL=postgresql://user:password@localhost:5432/db');
        expect(result.status).toBe('clean');
    });

    it('warns for live Stripe publishable keys', () => {
        const result = scanInputForCredentials('STRIPE_PUBLIC_KEY=pk_live_123456789012345678901234');
        expect(result.status).toBe('warning');
        expect(result.detections[0].decision).toBe('warn');
        expect(result.detections[0].reason_codes).toContain('public_live_key');
    });

    it('allows provider keys in comments (reduced false positives)', () => {
        const result = scanInputForCredentials('// AWS_ACCESS_KEY_ID=AKIAZ9Y8X7W6V5U4T3Q2');
        expect(result.status).toBe('clean');
    });

    it('allows GitHub tokens in comments', () => {
        const result = scanInputForCredentials('// ghp_Z9Y8X7W6V5U4T3S2R1Q0P9O8N7M6B5C4A3D2');
        expect(result.status).toBe('clean');
    });

    it('blocks JWT tokens in comments', () => {
        const jwt = '// token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJwcm9kLXVzZXIiLCJpc3MiOiJhdXRoLXNlcnZpY2UifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
        const result = scanInputForCredentials(jwt);
        expect(result.status).toBe('blocked');
        expect(result.detections.some(d => d.type === 'jwt_token')).toBe(true);
    });

    it('shows allowed safe values in clean output', () => {
        const result = scanInputForCredentials('api_key: "abcdefghijklmnopqrstuvwxyz"');
        const alert = formatDLPAlert(result);
        expect(alert).toContain('allowed 1 sample or safe credential-like value');
    });

    it('includes allowed detections without raw values in audit log', () => {
        const result = scanInputForCredentials('api_key: "abcdefghijklmnopqrstuvwxyz"');
        const entry = createDLPAuditEntry(result, { agent: 'claude' });
        const allowed = entry.allowed_detections as any[];
        expect(allowed).toHaveLength(1);
        expect(allowed[0].decision).toBe('allow');
        expect(allowed[0].match).toBeUndefined();
    });
});
