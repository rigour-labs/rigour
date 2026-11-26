import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const here = path.dirname(new URL(import.meta.url).pathname);

describe("removing codex's trust entries", () => {
    let home: string;
    beforeEach(() => {
        home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
    });
    afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

    it('from two processes at once loses neither one\'s removals and changes no other line', async () => {
        const entry = (p: string) => `[projects.${JSON.stringify(p)}]\ntrust_level = "trusted"\n`;
        const paths = (who: string) => Array.from({ length: 40 }, (_, i) => `/tmp/rigour-judge-copy-${who}${i}/repo`);
        const kept = `model = "example-model"\n\n${entry('/Users/dev-a/project')}\n[model_providers.acme]\nbase_url = "https://llm.example.com"\n`;
        fs.writeFileSync(path.join(home, 'config.toml'), [kept, ...paths('a').map(entry), ...paths('b').map(entry)].join('\n'), { mode: 0o600 });
        const remover = (who: string) => {
            const script = [
                `import { removeCodexTrust } from ${JSON.stringify(pathToFileURL(path.join(here, 'cli-leftovers.ts')).href)};`,
                `for (const p of ${JSON.stringify(paths(who))}) removeCodexTrust(${JSON.stringify(home)}, project => project === p);`,
            ].join('\n');
            const file = path.join(home, `remove-${who}.mts`);
            fs.writeFileSync(file, script);
            const child = spawn(process.execPath, ['--import', 'tsx', file], { cwd: path.join(here, '..', '..', '..'), stdio: 'ignore' });
            return new Promise<number | null>(resolve => child.on('close', resolve));
        };
        expect(await Promise.all([remover('a'), remover('b')])).toEqual([0, 0]);
        expect(fs.readFileSync(path.join(home, 'config.toml'), 'utf8')).toBe(kept);
        expect(fs.statSync(path.join(home, 'config.toml')).mode & 0o777).toBe(0o600);
        expect(fs.readdirSync(home).filter(name => /lock|tmp/.test(name))).toEqual([]);
    }, 60_000);
});
