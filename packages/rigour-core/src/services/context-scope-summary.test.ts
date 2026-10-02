import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getContextScopeSummary } from './context-telemetry-service.js';

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-summary-')); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('getContextScopeSummary', () => {
    it('counts rule files and skips a rules directory such as .clinerules/', async () => {
        fs.mkdirSync(path.join(root, '.clinerules'));
        fs.writeFileSync(path.join(root, '.clinerules', 'rigour.md'), 'rules');
        fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'Use small PRs.');
        const summary = await getContextScopeSummary(root);
        expect(summary.alwaysOnRuleTokens).toBeGreaterThan(0);
    });
});
