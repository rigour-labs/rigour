#!/usr/bin/env node
/**
 * Standalone DLP Checker — invoked directly by IDE hooks.
 *
 * Reads text from stdin, scans for credentials using the
 * InputValidationGate, and outputs JSON result to stdout.
 *
 * Exit codes:
 *   0 — clean (no credentials found)
 *   2 — blocked (credentials detected, transmission prevented)
 *
 * Usage:
 *   echo "my api_key = sk-abc123..." | node standalone-dlp-checker.js
 *   echo '{"content":"..."}' | node standalone-dlp-checker.js --json
 *
 * @since v4.2.0 — AI Agent DLP
 */

import { scanInputForCredentials, formatDLPAlert, createDLPAuditEntry } from './input-validator.js';
import fs from 'fs-extra';
import path from 'path';

async function main() {
    const args = process.argv.slice(2);
    const isJson = args.includes('--json');
    const block = !args.includes('--warn-only');
    const agent = args.find(a => a.startsWith('--agent='))?.split('=')[1] || 'unknown';

    // Read stdin
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
        chunks.push(chunk as Buffer);
    }
    const input = Buffer.concat(chunks).toString('utf-8').trim();

    if (!input) {
        process.stdout.write(JSON.stringify({ status: 'clean', detections: [], duration_ms: 0 }));
        return;
    }

    // Parse JSON input if flag set, otherwise scan raw text
    let textToScan = input;
    if (isJson) {
        try {
            const payload = JSON.parse(input);
            // Scan all string values in the payload
            const texts: string[] = [];
            function extractStrings(obj: unknown): void {
                if (typeof obj === 'string' && obj.length > 5) {
                    texts.push(obj);
                } else if (Array.isArray(obj)) {
                    obj.forEach(extractStrings);
                } else if (obj && typeof obj === 'object') {
                    Object.values(obj).forEach(extractStrings);
                }
            }
            extractStrings(payload);
            textToScan = texts.join('\n');
        } catch {
            // If JSON parse fails, scan as raw text
        }
    }

    const result = scanInputForCredentials(textToScan, {
        enabled: true,
        block_on_detection: block,
    });

    // Output JSON result to stdout
    process.stdout.write(JSON.stringify(result));

    // Log to stderr for visibility in IDE panels
    if (result.status !== 'clean') {
        process.stderr.write(formatDLPAlert(result) + '\n');

        // Append to audit trail
        try {
            const cwd = process.cwd();
            const rigourDir = path.join(cwd, '.rigour');
            await fs.ensureDir(rigourDir);
            const eventsPath = path.join(rigourDir, 'events.jsonl');
            const auditEntry = createDLPAuditEntry(result, { agent });
            await fs.appendFile(eventsPath, JSON.stringify(auditEntry) + '\n');
        } catch {
            // Silent fail on audit logging
        }
    }

    // Exit code: 2 = blocked, 0 = clean/warning
    if (result.status === 'blocked') {
        process.exitCode = 2;
    }
}

main().catch(err => {
    process.stderr.write(`Rigour DLP checker error: ${err.message}\n`);
    process.stdout.write(JSON.stringify({ status: 'clean', detections: [], duration_ms: 0 }));
});
