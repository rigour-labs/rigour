import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFindFiles = vi.hoisted(() => vi.fn());
const mockReadFile = vi.hoisted(() => vi.fn());
const mockPathExists = vi.hoisted(() => vi.fn());

vi.mock('../utils/scanner.js', () => ({
    FileScanner: { findFiles: mockFindFiles },
}));

vi.mock('fs-extra', () => ({
    default: {
        readFile: mockReadFile,
        pathExists: mockPathExists,
        pathExistsSync: vi.fn().mockReturnValue(false),
        readFileSync: vi.fn().mockReturnValue(''),
        readJson: vi.fn().mockResolvedValue(null),
        readdirSync: vi.fn().mockReturnValue([]),
    },
}));

import { PhantomApisGate } from './phantom-apis.js';

describe('PhantomApisGate — Node.js', () => {
    let gate: PhantomApisGate;

    beforeEach(() => {
        gate = new PhantomApisGate();
        vi.clearAllMocks();
    });

    it('should flag non-existent fs methods', async () => {
        mockFindFiles.mockResolvedValue(['src/utils.ts']);
        mockReadFile.mockResolvedValue(`
import fs from 'fs';
const data = fs.readFileAsync('test.txt');
const result = fs.writeFilePromise('out.txt', data);
        `);

        const failures = await gate.run({ cwd: '/project' });
        expect(failures).toHaveLength(1);
        expect(failures[0].details).toContain('readFileAsync');
        expect(failures[0].details).toContain('writeFilePromise');
    });

    it('should NOT flag real fs methods', async () => {
        mockFindFiles.mockResolvedValue(['src/utils.ts']);
        mockReadFile.mockResolvedValue(`
import fs from 'fs';
const data = fs.readFileSync('test.txt', 'utf-8');
fs.writeFileSync('out.txt', data);
fs.existsSync('/tmp');
const stream = fs.createReadStream('big.txt');
        `);

        const failures = await gate.run({ cwd: '/project' });
        expect(failures).toHaveLength(0);
    });

    it('should flag non-existent path methods', async () => {
        mockFindFiles.mockResolvedValue(['src/paths.ts']);
        mockReadFile.mockResolvedValue(`
import path from 'path';
const combined = path.combine('a', 'b');
const exists = path.exists('/tmp');
        `);

        const failures = await gate.run({ cwd: '/project' });
        expect(failures).toHaveLength(1);
        expect(failures[0].details).toContain('combine');
        expect(failures[0].details).toContain('exists');
    });

    it('should NOT flag real path methods', async () => {
        mockFindFiles.mockResolvedValue(['src/paths.ts']);
        mockReadFile.mockResolvedValue(`
import path from 'path';
const p = path.join('a', 'b');
const ext = path.extname('file.txt');
const abs = path.resolve('.');
        `);

        const failures = await gate.run({ cwd: '/project' });
        expect(failures).toHaveLength(0);
    });

    it('should flag non-existent crypto methods', async () => {
        mockFindFiles.mockResolvedValue(['src/crypto.ts']);
        mockReadFile.mockResolvedValue(`
import crypto from 'crypto';
const hash = crypto.generateHash('sha256', 'data');
const key = crypto.createKey('aes-256');
        `);

        const failures = await gate.run({ cwd: '/project' });
        expect(failures).toHaveLength(1);
        expect(failures[0].details).toContain('generateHash');
        expect(failures[0].details).toContain('createKey');
    });

    it('should NOT flag real crypto methods', async () => {
        mockFindFiles.mockResolvedValue(['src/crypto.ts']);
        mockReadFile.mockResolvedValue(`
import crypto from 'crypto';
const hash = crypto.createHash('sha256');
const uuid = crypto.randomUUID();
        `);

        const failures = await gate.run({ cwd: '/project' });
        expect(failures).toHaveLength(0);
    });

    it('should handle require() imports', async () => {
        mockFindFiles.mockResolvedValue(['src/legacy.js']);
        mockReadFile.mockResolvedValue(`
const fs = require('fs');
fs.readFileAsync('data.txt');
        `);

        const failures = await gate.run({ cwd: '/project' });
        expect(failures).toHaveLength(1);
        expect(failures[0].details).toContain('readFileAsync');
    });

    it('should handle node: protocol imports', async () => {
        mockFindFiles.mockResolvedValue(['src/modern.ts']);
        mockReadFile.mockResolvedValue(`
import os from 'node:os';
const info = os.cpuInfo();
        `);

        const failures = await gate.run({ cwd: '/project' });
        expect(failures).toHaveLength(1);
        expect(failures[0].details).toContain('cpuInfo');
    });

    it('should suggest closest real method', async () => {
        mockFindFiles.mockResolvedValue(['src/typo.ts']);
        mockReadFile.mockResolvedValue(`
import fs from 'fs';
fs.readFileSyn('data.txt');
        `);

        const failures = await gate.run({ cwd: '/project' });
        expect(failures).toHaveLength(1);
        expect(failures[0].details).toContain('readFileSync');
    });

    it('should not scan when disabled', async () => {
        const disabled = new PhantomApisGate({ enabled: false });
        const failures = await disabled.run({ cwd: '/project' });
        expect(failures).toHaveLength(0);
        expect(mockFindFiles).not.toHaveBeenCalled();
    });
});

describe('PhantomApisGate — Python', () => {
    let gate: PhantomApisGate;

    beforeEach(() => {
        gate = new PhantomApisGate();
        vi.clearAllMocks();
    });

    it('should flag non-existent os methods', async () => {
        mockFindFiles.mockResolvedValue(['utils.py']);
        mockReadFile.mockResolvedValue(`
import os
current = os.getCurrentDirectory()
files = os.listFiles('.')
        `);

        const failures = await gate.run({ cwd: '/project' });
        expect(failures).toHaveLength(1);
        expect(failures[0].details).toContain('getCurrentDirectory');
        expect(failures[0].details).toContain('listFiles');
    });

    it('should NOT flag real os methods', async () => {
        mockFindFiles.mockResolvedValue(['utils.py']);
        mockReadFile.mockResolvedValue(`
import os
current = os.getcwd()
files = os.listdir('.')
exists = os.path
        `);

        const failures = await gate.run({ cwd: '/project' });
        expect(failures).toHaveLength(0);
    });

    it('should flag non-existent json methods', async () => {
        mockFindFiles.mockResolvedValue(['parser.py']);
        mockReadFile.mockResolvedValue(`
import json
data = json.parse('{"key": "value"}')
result = json.stringify(data)
        `);

        const failures = await gate.run({ cwd: '/project' });
        expect(failures).toHaveLength(1);
        expect(failures[0].details).toContain('parse');
        expect(failures[0].details).toContain('stringify');
    });

    it('should NOT flag real json methods', async () => {
        mockFindFiles.mockResolvedValue(['parser.py']);
        mockReadFile.mockResolvedValue(`
import json
data = json.loads('{"key": "value"}')
output = json.dumps(data)
        `);

        const failures = await gate.run({ cwd: '/project' });
        expect(failures).toHaveLength(0);
    });

    it('should handle aliased imports', async () => {
        mockFindFiles.mockResolvedValue(['utils.py']);
        mockReadFile.mockResolvedValue(`
import os as operating_system
result = operating_system.getCurrentDirectory()
        `);

        const failures = await gate.run({ cwd: '/project' });
        expect(failures).toHaveLength(1);
        expect(failures[0].details).toContain('getCurrentDirectory');
    });

    it('should flag non-existent subprocess methods', async () => {
        mockFindFiles.mockResolvedValue(['runner.py']);
        mockReadFile.mockResolvedValue(`
import subprocess
result = subprocess.execute(['ls', '-la'])
        `);

        const failures = await gate.run({ cwd: '/project' });
        expect(failures).toHaveLength(1);
        expect(failures[0].details).toContain('execute');
    });
});

describe('PhantomApisGate — Go', () => {
    let gate: PhantomApisGate;

    beforeEach(() => {
        gate = new PhantomApisGate();
        vi.clearAllMocks();
    });

    it('should flag Python-style Go method names', async () => {
        mockFindFiles.mockResolvedValue(['main.go']);
        mockReadFile.mockResolvedValue(`
package main
import "strings"
func main() {
    result := strings.includes("hello", "ell")
}
        `);

        const failures = await gate.run({ cwd: '/project' });
        expect(failures).toHaveLength(1);
        expect(failures[0].details).toContain('includes');
        expect(failures[0].details).toContain('strings.Contains');
    });

    it('should flag JS-style JSON methods in Go', async () => {
        mockFindFiles.mockResolvedValue(['parser.go']);
        mockReadFile.mockResolvedValue(`
package main
import "encoding/json"
func parse() {
    data := json.parse(raw)
    out := json.stringify(data)
}
        `);

        const failures = await gate.run({ cwd: '/project' });
        expect(failures).toHaveLength(1);
        expect(failures[0].details).toContain('parse');
    });

    it('should flag os.Exists in Go', async () => {
        mockFindFiles.mockResolvedValue(['files.go']);
        mockReadFile.mockResolvedValue(`
package main
import "os"
func check() {
    exists := os.Exists("/tmp/file")
}
        `);

        const failures = await gate.run({ cwd: '/project' });
        expect(failures).toHaveLength(1);
        expect(failures[0].details).toContain('Exists');
    });
});

describe('PhantomApisGate — C#', () => {
    let gate: PhantomApisGate;

    beforeEach(() => {
        gate = new PhantomApisGate();
        vi.clearAllMocks();
    });

    it('should flag Java-style method casing in C#', async () => {
        mockFindFiles.mockResolvedValue(['Program.cs']);
        mockReadFile.mockResolvedValue(`
using System;
class Program {
    void Main() {
        string s = "hello";
        int len = s.length;
        bool eq = s.equals("world");
        string str = s.toString();
    }
}
        `);

        const failures = await gate.run({ cwd: '/project' });
        expect(failures.length).toBeGreaterThanOrEqual(1);
        expect(failures[0].details).toMatch(/length|equals|toString/);
    });

    it('should flag Java collections in C#', async () => {
        mockFindFiles.mockResolvedValue(['Service.cs']);
        mockReadFile.mockResolvedValue(`
using System.Collections.Generic;
List<string> items = new ArrayList<string>();
HashMap<string, int> map = new HashMap<string, int>();
System.out.println("hello");
        `);

        const failures = await gate.run({ cwd: '/project' });
        expect(failures.length).toBeGreaterThanOrEqual(1);
    });
});

describe('PhantomApisGate — Java', () => {
    let gate: PhantomApisGate;

    beforeEach(() => {
        gate = new PhantomApisGate();
        vi.clearAllMocks();
    });

    it('should flag JS/Python-style method names in Java', async () => {
        mockFindFiles.mockResolvedValue(['Main.java']);
        mockReadFile.mockResolvedValue(`
import java.util.List;
class Main {
    void test() {
        List<String> items = new ArrayList<>();
        items.push("hello");
        items.includes("test");
    }
}
        `);

        const failures = await gate.run({ cwd: '/project' });
        expect(failures.length).toBeGreaterThanOrEqual(1);
        expect(failures[0].details).toMatch(/push|includes/);
    });

    it('should flag new List() in Java', async () => {
        mockFindFiles.mockResolvedValue(['Service.java']);
        mockReadFile.mockResolvedValue(`
import java.util.*;
class Service {
    List<String> items = new List<String>();
    Map<String, Integer> map = new Map<String, Integer>();
}
        `);

        const failures = await gate.run({ cwd: '/project' });
        expect(failures.length).toBeGreaterThanOrEqual(1);
    });
});
