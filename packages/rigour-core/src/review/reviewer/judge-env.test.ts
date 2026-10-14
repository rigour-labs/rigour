import os from 'os';
import { describe, expect, it } from 'vitest';
import { insideAgentSession, judgeUnset } from './judge-env.js';
import { ADAPTERS } from './adapters.js';
import { defaultExec } from './exec.js';

/** The variables a Claude Desktop session sets for the commands it runs (names as measured; values synthetic). */
const HOST = {
    CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'claude-desktop', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH: '1',
    CLAUDE_CODE_SESSION_ID: 'synthetic-session', CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/synthetic.sock', ANTHROPIC_BASE_URL: 'https://proxy.example.invalid',
};

describe("a judge's environment", () => {
    it('drops CLAUDE_CODE_ENTRYPOINT for every judge, with Rigour\'s own key and what the team names, and nothing else', () => {
        expect(judgeUnset('claude', {})).toEqual(['RIGOUR_API_KEY', 'CLAUDE_CODE_ENTRYPOINT']);
        expect(judgeUnset('codex', { codex: { unset: ['OPENAI_API_KEY'] } })).toEqual(['RIGOUR_API_KEY', 'CLAUDE_CODE_ENTRYPOINT', 'OPENAI_API_KEY']);
        for (const kept of [...Object.keys(HOST).filter(name => name !== 'CLAUDE_CODE_ENTRYPOINT'), ...Object.keys(ADAPTERS.claude.env ?? {})]) expect(judgeUnset('claude', {})).not.toContain(kept);
    });

    it('reaches the judge without CLAUDE_CODE_ENTRYPOINT, with the rest of the session and the isolation Rigour sets', async () => {
        const saved = { ...process.env };
        Object.assign(process.env, HOST);
        try {
            const print = ['-e', 'process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(CLAUDE|ANTHROPIC)/.test(k)))))'];
            const run = await defaultExec(process.execPath, print, { cwd: os.tmpdir(), timeoutMs: 30_000, env: ADAPTERS.claude.env, unset: judgeUnset('claude', {}) });
            const seen = JSON.parse(run.stdout);
            expect(seen).not.toHaveProperty('CLAUDE_CODE_ENTRYPOINT');
            expect(seen).toMatchObject({ ...Object.fromEntries(Object.entries(HOST).filter(([name]) => name !== 'CLAUDE_CODE_ENTRYPOINT')), CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' });
        } finally {
            for (const name of Object.keys(HOST)) if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
        }
    });

    it("knows when Rigour runs inside another agent's session", () => {
        expect(insideAgentSession({ CLAUDECODE: '1' })).toBe(true);
        expect(insideAgentSession({ CLAUDE_CODE_ENTRYPOINT: 'cli' })).toBe(true);
        expect(insideAgentSession({ ANTHROPIC_BASE_URL: 'https://proxy.example.invalid' })).toBe(false);
    });
});
