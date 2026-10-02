import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeprecatedDependenciesGate, installedVersions, lineOfDependency } from './deprecated-dependencies.js';

let cwd: string;
beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'deprecated-deps-'));
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ dependencies: { request: '^2.88.0', 'left-pad': '^1.3.0' }, devDependencies: { '@scope/tool': '1.0.0' } }, null, 2));
    fs.writeFileSync(path.join(cwd, 'package-lock.json'), JSON.stringify({ packages: {
        'node_modules/request': { version: '2.88.2' },
        'node_modules/@scope/tool': { version: '1.0.0' },
    } }));
});
afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }));

/** A registry answering per exact version, like registry.npmjs.org/<name>/<version>. */
const registry = (deprecated: Record<string, string>) => vi.fn(async (url: string) => {
    const [, name, version] = /registry\.test\/(.+)\/([^/]+)$/.exec(url)!;
    return { ok: true, json: async () => ({ version, deprecated: deprecated[`${decodeURIComponent(name)}@${version}`] }) };
});

describe('DeprecatedDependenciesGate', () => {
    it('reports the installed version npm deprecated, on its package.json line', async () => {
        const fetch = registry({ 'request@2.88.2': 'request has been deprecated' });
        const failures = await new DeprecatedDependenciesGate({ enabled: true, registry: 'https://registry.test' }, fetch).run({ cwd });
        expect(failures).toEqual([expect.objectContaining({ id: 'deprecated-dependencies', files: ['package.json'], line: 3 })]);
        expect(failures[0].details).toContain('request@2.88.2 is deprecated on npm: request has been deprecated');
        expect(fetch.mock.calls.map(c => c[0])).toEqual(['https://registry.test/request/2.88.2', 'https://registry.test/@scope%2Ftool/1.0.0']);
    });

    it('asks once a day, and says nothing for a version it cannot determine or a registry that does not answer', async () => {
        const fetch = registry({ 'request@2.88.2': 'deprecated' });
        const gate = new DeprecatedDependenciesGate({ enabled: true, registry: 'https://registry.test' }, fetch);
        await gate.run({ cwd });
        await gate.run({ cwd });
        expect(fetch).toHaveBeenCalledTimes(2); // left-pad has no installed version; the second run is cached

        fs.rmSync(path.join(cwd, '.rigour'), { recursive: true });
        const down = vi.fn(async () => { throw new Error('offline'); });
        expect(await new DeprecatedDependenciesGate({ enabled: true }, down).run({ cwd })).toEqual([]);
    });

    it('is off unless enabled', async () => {
        const fetch = registry({});
        expect(await new DeprecatedDependenciesGate({}, fetch).run({ cwd })).toEqual([]);
        expect(fetch).not.toHaveBeenCalled();
    });
});

describe('helpers', () => {
    it('reads installed versions from the lockfile, else node_modules', async () => {
        fs.mkdirSync(path.join(cwd, 'node_modules', 'left-pad'), { recursive: true });
        fs.writeFileSync(path.join(cwd, 'node_modules', 'left-pad', 'package.json'), JSON.stringify({ version: '1.3.0' }));
        expect([...(await installedVersions(cwd, ['request', 'left-pad', 'missing']))]).toEqual([['request', '2.88.2'], ['left-pad', '1.3.0']]);
    });

    it('finds the line declaring a dependency', () => {
        expect(lineOfDependency('{\n  "dependencies": {\n    "request": "^2"\n  }\n}', 'request')).toBe(3);
        expect(lineOfDependency('{}', 'request')).toBeUndefined();
    });
});
