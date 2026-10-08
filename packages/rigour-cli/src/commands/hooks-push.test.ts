import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readThread } from '@rigour-labs/core';
import { hooksPushCommand, isPush, pushTarget } from './hooks-push.js';

describe('push command parsing', () => {
    it('acts on a real push only', () => {
        expect(isPush('git push -u origin feature')).toBe(true);
        expect(isPush('cd app && git -C . push')).toBe(true);
        expect(isPush('git push --dry-run')).toBe(false);
        expect(isPush('git status && npm test')).toBe(false);
        expect(isPush('echo "do not git pushx"')).toBe(false);
        expect(isPush('claude -p review --disallowedTools "Bash(git push:*)"')).toBe(false); // text inside an argument
        expect(isPush('npm test && git push origin main')).toBe(true);
        expect(isPush('git -C "/work/my app" push')).toBe(true);
    });

    it('finds the repository the push runs in', () => {
        expect(pushTarget('cd /work/app && git push')).toBe('/work/app');
        expect(pushTarget('git -C "/work/my app" push')).toBe('/work/my app');
        expect(pushTarget('git push')).toBeUndefined();
    });
});

describe('rigour hooks push', () => {
    let repo: string;
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    const write = (rel: string, body: string) => {
        fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
        fs.writeFileSync(path.join(repo, rel), body);
    };
    const push = (command = 'git push') => hooksPushCommand(JSON.stringify({ cwd: repo, tool_input: { command } }), '/');

    beforeEach(() => {
        repo = fs.mkdtempSync(path.join(os.tmpdir(), 'push-gate-'));
        git('init', '-q', '-b', 'main');
        git('config', 'user.email', 't@example.com');
        git('config', 'user.name', 't');
        git('config', 'commit.gpgsign', 'false');
        write('.gitignore', '.rigour/\nnode_modules/\n');
        write('src/main.ts', "import { used } from './util';\nconsole.log(used);\n");
        write('src/util.ts', 'export const used = 1;\n');
        write('package.json', '{"scripts":{"start":"node src/main.ts"}}\n');
        write('rigour.yml', 'version: 1\ngates:\n  unused_exports:\n    block: true\n'); // this team blocks on dead code
        git('add', '-A');
        git('commit', '-qm', 'init');
        git('checkout', '-q', '-b', 'feature');
    });
    afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

    it('blocks a push that leaves the scope its open pull request declares, and checks nothing without one', async () => {
        // A gh of our own on PATH: `pr view` answers with an open pull request, or fails.
        const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-gh-'));
        fs.writeFileSync(path.join(bin, 'gh.js'), "const reply = process.env.FAKE_GH;\nif (reply === 'fail') { console.error('no pull requests found'); process.exit(1); }\nconsole.log(JSON.stringify({ state: 'OPEN', body: '## Scope\\n- `src/`' }));\n");
        if (process.platform === 'win32') fs.writeFileSync(path.join(bin, 'gh.cmd'), `@"${process.execPath}" "%~dp0gh.js" %*\r\n`);
        else fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/gh.js" "$@"\n`, { mode: 0o755 });
        const saved = { PATH: process.env.PATH, FAKE_GH: process.env.FAKE_GH, GH_TOKEN: process.env.GH_TOKEN, RIGOUR_GITHUB_ACCOUNT: process.env.RIGOUR_GITHUB_ACCOUNT };
        process.env.PATH = [bin, process.env.PATH ?? ''].join(path.delimiter);
        delete process.env.GH_TOKEN; delete process.env.RIGOUR_GITHUB_ACCOUNT;
        try {
            write('rigour.yml', 'version: 1\nreview:\n  goal: on\n');
            write('docs/notes.md', '# notes\n');
            git('add', '-A');
            git('commit', '-qm', 'notes');
            process.env.FAKE_GH = 'fail';
            expect((await push()).exitCode).toBe(0); // gh failing: no goal to check, never a crash
            write('docs/notes.md', '# notes, again\n');
            git('commit', '-qam', 'notes again'); // a new HEAD: the description is read again
            process.env.FAKE_GH = 'open';
            const blocked = await push();
            expect(blocked.exitCode).toBe(2);
            expect(blocked.message).toContain('Changes docs/notes.md, outside the scope the description declares');
            expect(blocked.message).toContain('Changes rigour.yml, outside the scope'); // the branch changed it too
            expect(readThread(repo)!.events.filter(e => e.kind === 'goal').map(e => [e.moment, e.declared, e.blocks])).toEqual([['push', true, 2]]);
        } finally {
            for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
            fs.rmSync(bin, { recursive: true, force: true });
        }
    });

    it('lets any other command, and a clean branch, through', async () => {
        expect(await push('npm test')).toEqual({ exitCode: 0, message: '' });
        write('src/util.ts', 'export const used = 2;\n');
        git('commit', '-qam', 'tweak');
        expect(await push()).toEqual({ exitCode: 0, message: '' });
    });

    it('blocks a push when a check could not run: a TypeScript project whose program cannot be built', async () => {
        write('tsconfig.json', '{"extends":"./.generated/tsconfig.json"}\n');
        write('src/util.ts', 'export const used = 2;\n');
        git('add', '-A');
        git('commit', '-qm', 'typed change, broken config');
        const result = await push();
        expect(result.exitCode).toBe(2);
        expect(result.message).toContain('- typed-checks-unavailable could not run: ');
        expect(result.message).toContain('.generated/tsconfig.json');
        // The task's thread keeps the blocked push.
        expect(readThread(repo, 'feature')?.events.map(e => [e.kind, e.passed, e.failed])).toEqual([['push', false, 1]]);
    });

    it('blocks a push that adds an export nothing uses, saying where', async () => {
        write('src/util.ts', 'export const used = 1;\nexport const forgotten = 2;\n');
        git('commit', '-qam', 'add forgotten');
        const result = await push();
        expect(result.exitCode).toBe(2);
        expect(result.message).toContain('Push blocked');
        expect(result.message).toContain('src/util.ts:2 Unused export');
    });

    it("blocks a push the project's own formatter rejects, and keeps the output in a log", async () => {
        const bin = path.join(repo, 'node_modules', '.bin');
        fs.mkdirSync(bin, { recursive: true });
        fs.writeFileSync(path.join(bin, 'prettier.js'), "console.log('[warn] src/util.ts'); process.exit(1);\n");
        fs.writeFileSync(path.join(bin, 'prettier'), '#!/bin/sh\nexec node "$(dirname "$0")/prettier.js" "$@"\n', { mode: 0o755 });
        fs.writeFileSync(path.join(bin, 'prettier.cmd'), '@node "%~dp0\\prettier.js" %*\r\n');
        write('src/util.ts', 'export const used =   3;\n');
        git('commit', '-qam', 'unformatted');
        const result = await push();
        expect(result.exitCode).toBe(2);
        expect(result.message).toContain('- format failed: prettier --check');
        const log = result.message.match(/full output: (\S+)\)/)![1];
        expect(fs.readFileSync(log, 'utf8')).toContain('[warn] src/util.ts');
    });
});
