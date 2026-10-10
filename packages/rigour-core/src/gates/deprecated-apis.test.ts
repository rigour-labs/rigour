import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFindFiles = vi.hoisted(() => vi.fn());
const mockReadFile = vi.hoisted(() => vi.fn());

vi.mock('../utils/scanner.js', () => ({
    FileScanner: { findFiles: mockFindFiles },
}));

vi.mock('fs-extra', () => ({
    default: {
        readFile: mockReadFile,
        pathExists: vi.fn().mockResolvedValue(false),
        pathExistsSync: vi.fn().mockReturnValue(false),
        readFileSync: vi.fn().mockReturnValue(''),
        readJson: vi.fn().mockResolvedValue(null),
        readdirSync: vi.fn().mockReturnValue([]),
    },
}));

import { DeprecatedApisGate } from './deprecated-apis.js';
import { mustFix } from '../review/quiet.js';

describe('DeprecatedApisGate — a call written in a string or a comment', () => {
    beforeEach(() => { vi.clearAllMocks(); });

    it('is no use of the API; the call itself still is', async () => {
        mockFindFiles.mockResolvedValue(['app/fixtures.py']);
        mockReadFile.mockResolvedValue('MSG = "pickle.loads(x)"\nREASON = "subprocess.call(cmd, shell=True)"\ny = 2  # os.system(cmd)\n');
        expect(await new DeprecatedApisGate().run({ cwd: '/project' })).toEqual([]);
        mockReadFile.mockResolvedValue('import pickle\ndata = pickle.loads(x)\n');
        const failures = await new DeprecatedApisGate().run({ cwd: '/project' });
        expect(failures.map(f => f.details).join('\n')).toContain('pickle');
    });
});

describe('DeprecatedApisGate — Node.js Security', () => {
    let gate: DeprecatedApisGate;

    beforeEach(() => {
        gate = new DeprecatedApisGate();
        vi.clearAllMocks();
    });

    it('should flag new Buffer() as security-critical', async () => {
        mockFindFiles.mockResolvedValue(['src/handler.js']);
        mockReadFile.mockResolvedValue(`
const buf = new Buffer(100);
const buf2 = new Buffer('hello');
        `);

        const failures = await gate.run({ cwd: '/project' });
        expect(failures.length).toBeGreaterThanOrEqual(1);
        const secFail = failures.find(f => f.title === 'Security-Deprecated APIs');
        expect(secFail).toBeDefined();
        // Deprecated is not always vulnerable: by default a note (likely), never a block.
        expect(secFail).toMatchObject({ severity: 'high', certainty: 'likely' });
        expect(mustFix(secFail!)).toBe(false);
        expect(secFail!.details).toContain('Buffer');

        // The team's opt-in wins: critical, proven, and it blocks.
        const opted = (await new DeprecatedApisGate({ block_security_deprecated: true }).run({ cwd: '/project' })).find(f => f.title === 'Security-Deprecated APIs');
        expect(opted).toMatchObject({ severity: 'critical', certainty: 'proven' });
        expect(mustFix(opted!)).toBe(true);
    });

    it('leaves Python and Go test files out', async () => {
        mockFindFiles.mockResolvedValue([]);
        await gate.run({ cwd: '/project' });
        expect(mockFindFiles.mock.calls[0][0].ignore).toEqual(expect.arrayContaining(['**/test_*.py', '**/*_test.py', '**/conftest.py', '**/tests/**', '**/*_test.go']));
    });

    it('should flag crypto.createCipher as security-critical', async () => {
        mockFindFiles.mockResolvedValue(['src/encrypt.ts']);
        mockReadFile.mockResolvedValue(`
import crypto from 'crypto';
const cipher = crypto.createCipher('aes-256-cbc', 'password');
        `);

        const failures = await gate.run({ cwd: '/project' });
        expect(failures.length).toBeGreaterThanOrEqual(1);
        expect(failures[0].details).toContain('createCipher');
    });

    it('should flag document.write() as security risk', async () => {
        mockFindFiles.mockResolvedValue(['src/page.tsx']);
        mockReadFile.mockResolvedValue(`
document.write('<script>alert("xss")</script>');
        `);

        const failures = await gate.run({ cwd: '/project' });
        expect(failures.length).toBeGreaterThanOrEqual(1);
        expect(failures[0].details).toContain('document.write');
    });

    it('should flag eval() as security risk', async () => {
        mockFindFiles.mockResolvedValue(['src/dynamic.js']);
        mockReadFile.mockResolvedValue(`
const result = eval(userInput);
        `);

        const failures = await gate.run({ cwd: '/project' });
        expect(failures.length).toBeGreaterThanOrEqual(1);
        expect(failures[0].details).toContain('eval');
    });
});

describe('DeprecatedApisGate — Node.js Superseded', () => {
    let gate: DeprecatedApisGate;

    beforeEach(() => {
        gate = new DeprecatedApisGate();
        vi.clearAllMocks();
    });

    it('should flag url.parse() as superseded', async () => {
        mockFindFiles.mockResolvedValue(['src/router.ts']);
        mockReadFile.mockResolvedValue(`
import url from 'url';
const parsed = url.parse(req.url);
        `);

        const failures = await gate.run({ cwd: '/project' });
        expect(failures.length).toBeGreaterThanOrEqual(1);
        expect(failures[0].details).toContain('url.parse');
    });

    it('should flag fs.exists() as superseded', async () => {
        mockFindFiles.mockResolvedValue(['src/checker.ts']);
        mockReadFile.mockResolvedValue(`
const fs = require('fs');
fs.exists('/tmp/test', (exists) => {});
        `);

        const failures = await gate.run({ cwd: '/project' });
        expect(failures.length).toBeGreaterThanOrEqual(1);
        expect(failures[0].details).toContain('fs.exists');
    });

    it('should flag require("domain") as removed', async () => {
        mockFindFiles.mockResolvedValue(['src/app.js']);
        mockReadFile.mockResolvedValue(`
const domain = require('domain');
        `);

        const failures = await gate.run({ cwd: '/project' });
        expect(failures.length).toBeGreaterThanOrEqual(1);
        expect(failures[0].details).toContain('domain');
    });
});

describe('DeprecatedApisGate — Python', () => {
    let gate: DeprecatedApisGate;

    beforeEach(() => {
        gate = new DeprecatedApisGate();
        vi.clearAllMocks();
    });

    it('should flag pickle.loads() as security risk', async () => {
        mockFindFiles.mockResolvedValue(['handler.py']);
        mockReadFile.mockResolvedValue(`
import pickle
data = pickle.loads(untrusted_input)
        `);

        const failures = await gate.run({ cwd: '/project' });
        expect(failures.length).toBeGreaterThanOrEqual(1);
        expect(failures[0].details).toContain('pickle');
    });

    it('should flag os.system() as security risk', async () => {
        mockFindFiles.mockResolvedValue(['runner.py']);
        mockReadFile.mockResolvedValue(`
import os
os.system(user_command)
        `);

        const failures = await gate.run({ cwd: '/project' });
        expect(failures.length).toBeGreaterThanOrEqual(1);
        expect(failures[0].details).toContain('os.system');
    });

    it('should flag subprocess with shell=True', async () => {
        mockFindFiles.mockResolvedValue(['runner.py']);
        mockReadFile.mockResolvedValue(`
import subprocess
subprocess.run(cmd, shell=True)
        `);

        const failures = await gate.run({ cwd: '/project' });
        expect(failures.length).toBeGreaterThanOrEqual(1);
        expect(failures[0].details).toContain('shell=True');
    });

    it('should flag import imp as removed', async () => {
        mockFindFiles.mockResolvedValue(['loader.py']);
        mockReadFile.mockResolvedValue(`
import imp
module = imp.load_source('name', 'path')
        `);

        const failures = await gate.run({ cwd: '/project' });
        expect(failures.length).toBeGreaterThanOrEqual(1);
        expect(failures[0].details).toContain('imp');
    });

    it('should flag from distutils as removed', async () => {
        mockFindFiles.mockResolvedValue(['setup.py']);
        mockReadFile.mockResolvedValue(`
from distutils.core import setup
        `);

        const failures = await gate.run({ cwd: '/project' });
        expect(failures.length).toBeGreaterThanOrEqual(1);
        expect(failures[0].details).toContain('distutils');
    });

    it('should flag typing.Dict as superseded', async () => {
        mockFindFiles.mockResolvedValue(['models.py']);
        mockReadFile.mockResolvedValue(`
from typing import Dict, List, Optional
        `);

        const failures = await gate.run({ cwd: '/project' });
        expect(failures.length).toBeGreaterThanOrEqual(1);
    });

    it('should not flag when disabled', async () => {
        const disabled = new DeprecatedApisGate({ enabled: false });
        const failures = await disabled.run({ cwd: '/project' });
        expect(failures).toHaveLength(0);
    });
});

describe('DeprecatedApisGate — Go', () => {
    let gate: DeprecatedApisGate;

    beforeEach(() => {
        gate = new DeprecatedApisGate();
        vi.clearAllMocks();
    });

    it('should flag ioutil usage as deprecated', async () => {
        mockFindFiles.mockResolvedValue(['main.go']);
        mockReadFile.mockResolvedValue(`
package main
import "io/ioutil"
func main() {
    data, _ := ioutil.ReadFile("test.txt")
    ioutil.WriteFile("out.txt", data, 0644)
}
        `);

        const failures = await gate.run({ cwd: '/project' });
        expect(failures.length).toBeGreaterThanOrEqual(1);
        expect(failures[0].details).toContain('ioutil');
    });

    it('should flag strings.Title as deprecated', async () => {
        mockFindFiles.mockResolvedValue(['util.go']);
        mockReadFile.mockResolvedValue(`
package util
import "strings"
func Title(s string) string {
    return strings.Title(s)
}
        `);

        const failures = await gate.run({ cwd: '/project' });
        expect(failures.length).toBeGreaterThanOrEqual(1);
        expect(failures[0].details).toContain('strings.Title');
    });
});

describe('DeprecatedApisGate — C#', () => {
    let gate: DeprecatedApisGate;

    beforeEach(() => {
        gate = new DeprecatedApisGate();
        vi.clearAllMocks();
    });

    it('should flag BinaryFormatter as security-deprecated', async () => {
        mockFindFiles.mockResolvedValue(['Serializer.cs']);
        mockReadFile.mockResolvedValue(`
using System.Runtime.Serialization.Formatters.Binary;
var formatter = new BinaryFormatter();
        `);

        const failures = await gate.run({ cwd: '/project' });
        expect(failures.length).toBeGreaterThanOrEqual(1);
        expect(failures[0].details).toContain('BinaryFormatter');
    });

    it('should flag WebClient as deprecated', async () => {
        mockFindFiles.mockResolvedValue(['HttpHelper.cs']);
        mockReadFile.mockResolvedValue(`
using System.Net;
var client = new WebClient();
        `);

        const failures = await gate.run({ cwd: '/project' });
        expect(failures.length).toBeGreaterThanOrEqual(1);
        expect(failures[0].details).toContain('WebClient');
    });

    it('should flag Thread.Abort as removed', async () => {
        mockFindFiles.mockResolvedValue(['Worker.cs']);
        mockReadFile.mockResolvedValue(`
using System.Threading;
Thread.Abort();
        `);

        const failures = await gate.run({ cwd: '/project' });
        expect(failures.length).toBeGreaterThanOrEqual(1);
    });
});

describe('DeprecatedApisGate — Java', () => {
    let gate: DeprecatedApisGate;

    beforeEach(() => {
        gate = new DeprecatedApisGate();
        vi.clearAllMocks();
    });

    it('should flag Vector and Hashtable as deprecated', async () => {
        mockFindFiles.mockResolvedValue(['Legacy.java']);
        mockReadFile.mockResolvedValue(`
import java.util.*;
Vector<String> v = new Vector<String>();
Hashtable<String, Integer> ht = new Hashtable<String, Integer>();
        `);

        const failures = await gate.run({ cwd: '/project' });
        expect(failures.length).toBeGreaterThanOrEqual(1);
    });

    it('should flag new Integer() as deprecated', async () => {
        mockFindFiles.mockResolvedValue(['Boxing.java']);
        mockReadFile.mockResolvedValue(`
Integer x = new Integer(42);
Long y = new Long(100L);
        `);

        const failures = await gate.run({ cwd: '/project' });
        expect(failures.length).toBeGreaterThanOrEqual(1);
        expect(failures[0].details).toMatch(/Integer|Long/);
    });

    it('should flag Thread.stop as security-deprecated', async () => {
        mockFindFiles.mockResolvedValue(['ThreadManager.java']);
        mockReadFile.mockResolvedValue(`
thread.stop();
        `);

        const failures = await gate.run({ cwd: '/project' });
        expect(failures.length).toBeGreaterThanOrEqual(1);
    });

    it('should flag finalize() as deprecated', async () => {
        mockFindFiles.mockResolvedValue(['Resource.java']);
        mockReadFile.mockResolvedValue(`
class Resource {
    protected void finalize() throws Throwable {
        super.finalize();
    }
}
        `);

        const failures = await gate.run({ cwd: '/project' });
        expect(failures.length).toBeGreaterThanOrEqual(1);
        expect(failures[0].details).toContain('finalize');
    });
});

describe('DeprecatedApisGate — word fragments and non-code text', () => {
    let gate: DeprecatedApisGate;

    beforeEach(() => {
        gate = new DeprecatedApisGate();
        vi.clearAllMocks();
    });

    async function apisFor(file: string, source: string): Promise<string> {
        mockFindFiles.mockResolvedValue([file]);
        mockReadFile.mockResolvedValue(source);
        const failures = await gate.run({ cwd: '/project' });
        return failures.map(f => f.details).join('\n');
    }

    it('does not flag ArrayBuffer or SharedArrayBuffer as the Buffer() constructor', async () => {
        const details = await apisFor('src/lib/ingestion-proxy.ts', 'const empty = new ArrayBuffer(0);\nconst shared = new SharedArrayBuffer(8);\n');
        expect(details).not.toContain('Buffer() constructor');
    });

    it('still flags a bare Buffer() constructor call', async () => {
        expect(await apisFor('src/handler.js', "const b = Buffer(10);\n")).toContain('Buffer() constructor');
    });

    it('does not flag "with (" inside a trailing comment or a string', async () => {
        const details = await apisFor('src/lib/aliases.ts', [
            "const pattern = compile(source); // match with (optional) prefix",
            "const label = 'works with (legacy) clients';",
        ].join('\n'));
        expect(details).not.toContain('with statement');
    });

    it('still flags a real with statement', async () => {
        expect(await apisFor('src/legacy.js', 'with (obj) {\n  x = 1;\n}\n')).toContain('with statement');
    });
});
