import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyConfigMigrations, configMigrations, isOldEditHook } from './setup-migrations.js';

let cwd: string;
const write = (body: string) => fs.writeFileSync(path.join(cwd, 'rigour.yml'), body);
const read = () => fs.readFileSync(path.join(cwd, 'rigour.yml'), 'utf8');
beforeEach(() => { cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'migrations-')); });
afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }));

describe('what an older Rigour left behind', () => {
    it('knows the old edit hook by the variable it passes', () => {
        expect(isOldEditHook('rigour hooks check --files "$TOOL_INPUT_file_path"')).toBe(true);
        expect(isOldEditHook('rigour hooks check --stdin')).toBe(false);
    });

    it('restores blocking for a file made from a blocking preset before gates.security.block, keeping its comments', () => {
        write('version: 1\npreset: healthcare\n# our own note\ngates:\n  security:\n    enabled: true\n');
        expect(configMigrations(cwd)).toEqual([expect.objectContaining({ id: 'preset-security-block', automatic: true })]);
        expect(applyConfigMigrations(cwd)).toEqual([expect.stringContaining('gates.security.block: true')]);
        expect(read()).toContain('# our own note');
        expect(read()).toMatch(/security:\n {4}enabled: true\n {4}block: true/);
        expect(configMigrations(cwd)).toEqual([]); // done once
    });

    it('leaves a team choice alone: block set either way, a preset that does not block, no file', () => {
        write('version: 1\npreset: healthcare\ngates:\n  security:\n    block: false\n');
        expect(configMigrations(cwd)).toEqual([]);
        write('version: 1\npreset: ui\n');
        expect(configMigrations(cwd)).toEqual([]);
        fs.rmSync(path.join(cwd, 'rigour.yml'));
        expect(configMigrations(cwd)).toEqual([]);
        expect(applyConfigMigrations(cwd)).toEqual([]);
    });

    it('flags block_security_deprecated: true, which older init wrote for everyone, and never changes it', () => {
        const body = 'version: 1\ngates:\n  deprecated_apis:\n    block_security_deprecated: true\n';
        write(body);
        expect(configMigrations(cwd)).toEqual([expect.objectContaining({ id: 'security-deprecated-default', automatic: false })]);
        expect(applyConfigMigrations(cwd)).toEqual([]);
        expect(read()).toBe(body);
    });
});
