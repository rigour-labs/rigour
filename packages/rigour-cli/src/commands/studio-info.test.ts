import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { repoName } from './studio-info.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-info-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe("Studio's name for the repository", () => {
    it('is the origin remote\'s repository name, over https or ssh, never a path or a package name', () => {
        const repo = path.join(dir, 'checkout-folder');
        fs.mkdirSync(repo);
        execFileSync('git', ['-C', repo, 'init', '-q']);
        fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"some-monorepo","version":"1.0.0"}');
        execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'git@github.com:acme/payments.git']);
        expect(repoName(repo)).toBe('payments');
        execFileSync('git', ['-C', repo, 'remote', 'set-url', 'origin', 'https://github.com/acme/payments']);
        expect(repoName(repo)).toBe('payments');
    });

    it('is the checkout\'s folder name without a remote', () => {
        const repo = path.join(dir, 'my-project');
        fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
        execFileSync('git', ['-C', repo, 'init', '-q']);
        expect(repoName(path.join(repo, 'src'))).toBe('my-project');
    });
});
