import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('./config-reference.mjs', import.meta.url));

test('every rigour.yml setting is described, and docs/CONFIG_REFERENCE.md is what the schema renders', () => {
    const run = spawnSync(process.execPath, [script, '--check'], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
});
