import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { deprecationWarnings, lostOrChanged, secretFindings, snapshot } from './release-gates.mjs';

test('a deprecation warning in an install is found, and nothing else is', () => {
  const output = [
    'npm warn Unknown user config "always-auth".',
    'npm warn deprecated node-domexception@1.0.0: Use your platform\'s native DOMException instead',
    'added 120 packages in 4s',
    'NPM WARN DEPRECATED glob@7.2.3: Glob versions prior to v9 are no longer supported',
  ].join('\n');
  assert.deepEqual(deprecationWarnings(output), [
    'npm warn deprecated node-domexception@1.0.0: Use your platform\'s native DOMException instead',
    'NPM WARN DEPRECATED glob@7.2.3: Glob versions prior to v9 are no longer supported',
  ]);
  assert.deepEqual(deprecationWarnings('added 3 packages'), []);
});

test('credential-shaped strings are found by kind; ordinary code is not', () => {
  // Assembled at run time so this file carries no credential-shaped string itself.
  const aws = 'AKIA' + 'IOSFODNN7EXAMPLE';
  const key = '-----BEGIN ' + 'RSA PRIVATE KEY-----';
  const gh = 'ghp' + '_' + 'a'.repeat(36);
  assert.deepEqual(secretFindings(`const k = "${aws}";`), ['AWS access key']);
  assert.deepEqual(secretFindings(`${key}\nMIIE...`), ['private key']);
  assert.deepEqual(secretFindings(`token=${gh}`), ['GitHub token']);
  assert.deepEqual(secretFindings('const AKIA = 1; // sk-short ghp_short'), []);
});

test('an upgrade loses or changes nothing outside what a run may rewrite', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gates-test-'));
  mkdirSync(join(dir, '.rigour'));
  mkdirSync(join(dir, '.git'));
  writeFileSync(join(dir, 'rigour.yml'), 'version: 1\n');
  writeFileSync(join(dir, '.rigour', 'state.json'), '{}');
  writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  const before = snapshot(dir);
  assert.deepEqual(Object.keys(before).sort(), ['.rigour/state.json', 'rigour.yml']); // .git is not the tool's
  writeFileSync(join(dir, '.rigour', 'state.json'), '{"runs":1}');
  assert.deepEqual(lostOrChanged(before, snapshot(dir), [/^\.rigour\//]), []);
  writeFileSync(join(dir, 'rigour.yml'), 'version: 2\n');
  assert.deepEqual(lostOrChanged(before, snapshot(dir), [/^\.rigour\//]), ['rigour.yml']);
});
