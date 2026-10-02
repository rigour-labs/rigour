/**
 * Studio's index refresh, in its own process: building embeddings is CPU-bound and, run inside the
 * Studio server, kept every page waiting until it finished (37 s on a mid-size repository).
 */
import { ensureAutomaticIndex } from '@rigour-labs/core';

const cwd = process.argv[2];
if (cwd) {
    ensureAutomaticIndex(cwd).catch((error: unknown) => {
        process.stderr.write(`Structural index is degraded: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    });
}
