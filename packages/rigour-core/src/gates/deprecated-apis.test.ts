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
        expect(secFail!.severity).toBe('critical');
        expect(secFail!.details).toContain('Buffer');
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
