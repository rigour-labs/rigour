import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { observedSavings, recordAgentActivity, recordHookPayload, recordScopeOffer } from './observed-savings.js';

let cwd: string;
beforeEach(() => { cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'observed-savings-')); });
afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

const T = 1_000_000;

describe('observedSavings', () => {
    it('counts only scoped files the agent did not read afterwards, less the summary', () => {
        recordScopeOffer(cwd, [{ path: 'src/a.ts', tokens: 3000 }, { path: 'src/b.ts', tokens: 2000 }], 400, T);
        recordAgentActivity(cwd, 'Read', path.join(cwd, 'src/a.ts'), T + 60_000);  // read anyway
        recordAgentActivity(cwd, 'Edit', path.join(cwd, 'src/b.ts'), T + 90_000);  // an edit is not a read
        expect(observedSavings(cwd)).toEqual({ scopes: 1, trackedScopes: 1, offeredTokens: 5000, readBackTokens: 3000, avoidedTokens: 1600 });
    });

    it('claims nothing for a scope no hook observed, so a missing hook never reads as a saving', () => {
        recordScopeOffer(cwd, [{ path: 'src/a.ts', tokens: 3000 }], 400, T);
        expect(observedSavings(cwd)).toMatchObject({ scopes: 1, trackedScopes: 0, avoidedTokens: 0 });
    });

    it('ignores activity outside the observation window', () => {
        recordScopeOffer(cwd, [{ path: 'src/a.ts', tokens: 3000 }], 400, T);
        recordAgentActivity(cwd, 'Read', 'src/a.ts', T + 2 * 60 * 60 * 1000);
        expect(observedSavings(cwd).trackedScopes).toBe(0);
    });

    it('never claims more than was offered when the summary outweighs unread files', () => {
        recordScopeOffer(cwd, [{ path: 'src/a.ts', tokens: 100 }], 400, T);
        recordAgentActivity(cwd, 'Grep', undefined, T + 1000);
        expect(observedSavings(cwd).avoidedTokens).toBe(0);
    });

    it('reads a Claude Code PreToolUse payload: the tool, the file it reads, and its working directory', () => {
        recordScopeOffer(cwd, [{ path: 'src/a.ts', tokens: 3000 }], 400, T);
        recordHookPayload({ tool_name: 'Read', tool_input: { file_path: path.join(cwd, 'src/a.ts') }, cwd }, '/elsewhere', T + 1000);
        recordHookPayload({ hello: 'not a tool call' }, cwd, T + 2000);
        expect(observedSavings(cwd)).toMatchObject({ trackedScopes: 1, readBackTokens: 3000, avoidedTokens: 0 });
    });
});
