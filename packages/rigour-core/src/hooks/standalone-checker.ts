#!/usr/bin/env node
/**
 * Standalone hook checker entry point.
 *
 * Can be invoked two ways:
 *   1. CLI args:  node rigour-hook-checker.js --files path/to/file.ts
 *   2. Stdin:     echo '{"file_path":"x.ts"}' | node rigour-hook-checker.js --stdin
 *
 * Exit codes:
 *   0 = pass (or warn-only mode)
 *   2 = block (fail + block_on_failure enabled)
 *
 * @since v3.0.0
 */

import { runHookChecker } from './checker.js';

const EMPTY_RESULT = JSON.stringify({ status: 'pass', failures: [], duration_ms: 0 });

/**
 * Read all of stdin as a string.
 */
async function readStdin(): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
        chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString('utf-8').trim();
}

/**
 * Parse file paths from stdin JSON payload.
 *
 * Supports multiple formats from different tools:
 *   Cursor:   { file_path, old_content, new_content }
 *   Windsurf: { file_path, content }
 *   Cline:    { toolName, toolInput: { path } }
 *   Array:    { files: ["a.ts", "b.ts"] }
 */
function parseStdinFiles(input: string): string[] {
    if (!input) {
        return [];
    }
    try {
        const payload = JSON.parse(input);
        // Array format
        if (Array.isArray(payload.files)) {
            return payload.files;
        }
        // Direct file_path (Cursor/Windsurf)
        if (payload.file_path) {
            return [payload.file_path];
        }
        // Cline format: { toolInput: { path } }
        if (payload.toolInput?.path) {
            return [payload.toolInput.path];
        }
        if (payload.toolInput?.file_path) {
            return [payload.toolInput.file_path];
        }
        return [];
    } catch {
        // Not JSON — treat each line as a file path
        return input.split('\n').map(l => l.trim()).filter(Boolean);
    }
}

/**
 * Parse file paths from CLI --files argument.
 */
function parseCliFiles(args: string[]): string[] {
    const filesIdx = args.indexOf('--files');
    if (filesIdx === -1 || !args[filesIdx + 1]) {
        return [];
    }
    return args[filesIdx + 1].split(',').map(f => f.trim()).filter(Boolean);
}

/**
 * Log failures to stderr in human-readable format.
 */
function logFailures(failures: Array<{ gate: string; file: string; message: string; line?: number }>): void {
    for (const f of failures) {
        const loc = f.line ? `:${f.line}` : '';
        process.stderr.write(`[rigour/${f.gate}] ${f.file}${loc}: ${f.message}\n`);
    }
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const cwd = process.cwd();

    const files = args.includes('--stdin')
        ? parseStdinFiles(await readStdin())
        : parseCliFiles(args);

    if (files.length === 0) {
        process.stdout.write(EMPTY_RESULT);
        return;
    }

    const result = await runHookChecker({ cwd, files });

    process.stdout.write(JSON.stringify(result));

    if (result.status === 'fail') {
        logFailures(result.failures);
    }

    // Exit 2 = block signal for tools that respect it
    if (result.status === 'fail' && args.includes('--block')) {
        process.exit(2);
    }
}

main().catch((err: Error) => {
    process.stderr.write(`Rigour hook checker fatal error: ${err.message}\n`);
    process.exit(1);
});
