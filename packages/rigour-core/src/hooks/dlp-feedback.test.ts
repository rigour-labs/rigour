import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs-extra';
import {
    recordDLPFeedback,
    feedbackFingerprint,
    loadDLPFeedbackStoreSync,
    isLearnedAllowSync,
    writeDLPBlockManifest,
    allowLastDLPBlock,
} from './dlp-feedback.js';
import { scanInputForCredentials } from './input-validator.js';

describe('DLP feedback learning', () => {
    const testCwd = path.join(os.tmpdir(), `rigour-dlp-fb-${Date.now()}`);

    beforeEach(async () => {
        await fs.ensureDir(path.join(testCwd, '.rigour'));
    });

    afterEach(async () => {
        await fs.remove(testCwd);
    });

    it('produces stable fingerprints for same shape', () => {
        const a = feedbackFingerprint('password_assignment', 'api_key = "your-key-here"');
        const b = feedbackFingerprint('password_assignment', 'api_key = "your-key-here"');
        expect(a).toBe(b);
    });

    it('records and applies learned false positives', async () => {
        const match = 'api_key = "Z9y8X7w6V5u4T3s2R1q0P9o8N7m6B5c4"';
        await recordDLPFeedback(testCwd, { type: 'password_assignment', match, source: 'hook' });

        const store = loadDLPFeedbackStoreSync(testCwd);
        expect(isLearnedAllowSync(store, 'password_assignment', match)).toBe(true);

        const result = scanInputForCredentials(match, { cwd: testCwd });
        expect(result.status).toBe('clean');
        expect(result.allowed_detections?.[0].reason_codes).toContain('learned_false_positive');
    });

    it('allowLastDLPBlock learns from manifest', async () => {
        const text = 'api_key = "Z9y8X7w6V5u4T3s2R1q0P9o8N7m6B5c4"';
        const blocked = scanInputForCredentials(text, { cwd: testCwd, block_on_detection: true });
        expect(blocked.status).toBe('warning');

        await writeDLPBlockManifest(testCwd, blocked.detections, text);
        const learned = await allowLastDLPBlock(testCwd, 'hook');
        expect(learned).toBeGreaterThan(0);

        const retry = scanInputForCredentials(text, { cwd: testCwd });
        expect(retry.status).toBe('clean');
    });
});
