import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { generateHookFiles, pushCommandFor, pushGateShell, stopCommandFor } from './templates.js';

const CHECKER = 'npx @rigour-labs/cli@6.5.0 hooks check';

describe('hook templates', () => {
    it('reviews before the agent stops when the checker is the CLI, like `rigour hooks init`', () => {
        const claude = JSON.parse(generateHookFiles('claude', CHECKER)[0].content);
        expect(claude.hooks.Stop[0].hooks[0]).toEqual({ type: 'command', command: 'npx @rigour-labs/cli@6.5.0 hooks stop --tool claude', timeout: 120 });
        const cursor = JSON.parse(generateHookFiles('cursor', CHECKER).find(f => f.path.endsWith('hooks.json'))!.content);
        expect(cursor.hooks.stop[0]).toEqual({ command: 'npx @rigour-labs/cli@6.5.0 hooks stop --tool cursor', loop_limit: 3 });
    });

    it("gates the agent's git push when the checker is the CLI", () => {
        const claude = JSON.parse(generateHookFiles('claude', CHECKER)[0].content);
        expect(claude.hooks.PreToolUse[0]).toEqual({ matcher: 'Bash', hooks: [{ type: 'command', command: expect.stringContaining('npx @rigour-labs/cli@6.5.0 hooks push --stdin'), timeout: 1800 }] });
        expect(pushCommandFor('node ./my-checker.js')).toBeUndefined();
    });

    it.skipIf(process.platform === 'win32')('starts the push gate only for a command that mentions git push', () => {
        const run = (command: string) => execFileSync('sh', ['-c', pushGateShell('cat > /dev/null; echo gated; exit 2').replace(/^sh -c /, '').slice(1, -1)], { input: JSON.stringify({ tool_input: { command } }), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
        expect(run('npm test')).toBe('');
        expect(() => run('git push -u origin main')).toThrow(); // the gate's exit 2 reaches the agent
    });

    it('adds no stop hook for a checker that is not the CLI', () => {
        expect(stopCommandFor('node ./my-checker.js', 'claude')).toBeUndefined();
        const claude = JSON.parse(generateHookFiles('claude', 'node ./my-checker.js')[0].content);
        expect(claude.hooks.Stop).toBeUndefined();
    });
});
