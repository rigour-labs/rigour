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
import { generateDLPHookFiles } from './dlp-templates.js';

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
        await recordDLPFeedback(testCwd, {
            type: 'password_assignment',
            match,
            confidence: 55,
            source: 'hook',
        });

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

    it('never learns provider or high-confidence detections', async () => {
        const provider = await recordDLPFeedback(testCwd, {
            type: 'openai_key',
            match: 'sk-proj-Z9Y8X7W6V5U4T3S2R1Q0P9O8N7M6',
            confidence: 92,
        });
        const highConfidence = await recordDLPFeedback(testCwd, {
            type: 'password_assignment',
            match: 'password = "Z9y8X7w6V5u4T3s2R1q0P9o8N7m6B5c4"',
            confidence: 95,
        });

        expect(provider).toBeNull();
        expect(highConfidence).toBeNull();
        expect(loadDLPFeedbackStoreSync(testCwd).entries).toHaveLength(0);
    });

    it('does not retain raw credential fragments in manifests', async () => {
        const text = 'api_key = "Z9y8X7w6V5u4T3s2R1q0P9o8N7m6B5c4"';
        const result = scanInputForCredentials(text);
        expect(result.detections[0].match).toBe(result.detections[0].redacted);
        expect(result.detections[0].match).not.toContain('Z9y8X7w6V5u4T3s2R1q0P9o8N7m6B5c4');
        await writeDLPBlockManifest(testCwd, result.detections, text);

        const manifest = fs.readFileSync(path.join(testCwd, '.rigour', 'dlp-last-block.json'), 'utf-8');
        expect(manifest).not.toContain('Z9y8X7w6V5u4T3s2R1q0P9o8N7m6B5c4');
        expect(manifest).not.toContain('match');
        expect(manifest).not.toContain('shape');
    });

    it('rejects and consumes expired manifests', async () => {
        const text = 'api_key = "Z9y8X7w6V5u4T3s2R1q0P9o8N7m6B5c4"';
        const result = scanInputForCredentials(text);
        await writeDLPBlockManifest(testCwd, result.detections, text);
        const manifestPath = path.join(testCwd, '.rigour', 'dlp-last-block.json');
        const manifest = fs.readJsonSync(manifestPath);
        manifest.timestamp = '2020-01-01T00:00:00.000Z';
        fs.writeJsonSync(manifestPath, manifest);

        expect(await allowLastDLPBlock(testCwd, 'hook')).toBe(0);
        expect(fs.existsSync(manifestPath)).toBe(false);
    });

    it('rejects and consumes malformed manifests', async () => {
        const manifestPath = path.join(testCwd, '.rigour', 'dlp-last-block.json');
        fs.writeFileSync(manifestPath, '{not-json');

        expect(await allowLastDLPBlock(testCwd, 'hook')).toBe(0);
        expect(fs.existsSync(manifestPath)).toBe(false);
    });
});

describe('DLP scanner URL boundaries', () => {
    it('detects genuine HTTP basic-auth credentials', () => {
        const result = scanInputForCredentials('https://alice:S3cr3t-Prod-9842@example.com/v1');
        expect(result.status).toBe('warning');
        expect(result.detections.some(d => d.type === 'credentials_in_url')).toBe(true);
    });

    it('allows signed GCS URLs without URL user-info', () => {
        const url = 'https://storage.googleapis.com/example/archive.zip'
            + '?X-Goog-Credential=service%40example.invalid&X-Goog-Signature=redacted';
        expect(scanInputForCredentials(url).status).toBe('clean');
    });

    it('does not cross multiline JSON boundaries while scanning URLs', () => {
        const input = `{
            "task_archive_url": "https://storage.googleapis.com/example/archive.zip",
            "provider": { "npm": "@ai-sdk/openai-compatible" }
        }`;
        expect(scanInputForCredentials(input).status).toBe('clean');
    });

    it('allows nested OpenCode configuration with scoped npm packages', () => {
        const config = JSON.stringify({
            $schema: 'https://opencode.ai/config.json',
            provider: {
                moonshot: {
                    npm: '@ai-sdk/openai-compatible',
                    options: {
                        baseURL: 'https://api.moonshot.ai/v1',
                        apiKey: '{env:OPENAI_API_KEY}',
                    },
                },
            },
        }, null, 2);
        expect(scanInputForCredentials(config).status).toBe('clean');
    });
});

describe('DLP hook warning templates', () => {
    it.each(['cursor', 'cline', 'windsurf'] as const)(
        'generates non-blocking %s warnings',
        (tool) => {
            const content = generateDLPHookFiles(tool, 'rigour hooks check')
                .map(file => file.content)
                .join('\n');
            expect(content).toContain('possible credential');
            expect(content).not.toContain('process.exit(2)');
        },
    );
});
