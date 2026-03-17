#!/usr/bin/env node
/**
 * rigour-scan — shortcut for `npx @rigour-labs/cli scan`
 *
 * Usage: npx rigour-scan [options]
 *
 * Passes all arguments through to `@rigour-labs/cli scan`.
 */
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const args = process.argv.slice(2);

try {
    execFileSync('npx', ['-y', '@rigour-labs/cli', 'scan', ...args], {
        stdio: 'inherit',
        env: process.env,
    });
} catch (err) {
    // Exit with the child's exit code if available
    process.exit(err.status ?? 1);
}
