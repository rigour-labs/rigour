import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { configureHelp } from './cli-help.js';

function program(): Command {
    const p = new Command('rigour');
    for (const name of ['setup', 'review', 'studio', 'doctor', 'check', 'scan', 'learn']) p.command(name).description(name);
    return p;
}

describe('rigour help', () => {
    it('lists the four everyday commands and says how to see the rest', () => {
        const p = program();
        configureHelp(p, ['node', 'rigour', '--help']);
        const text = p.helpInformation() + '\n';
        expect(text).toMatch(/setup[\s\S]*review[\s\S]*studio[\s\S]*doctor/);
        expect(text).not.toMatch(/\n\s+check\b/);
    });

    it('lists every command with --all, and drops the flag before parsing', () => {
        const p = program();
        const argv = configureHelp(p, ['node', 'rigour', 'help', '--all']);
        expect(argv).toEqual(['node', 'rigour', 'help']);
        expect(p.helpInformation()).toMatch(/\n\s+check\b/);
    });

    it('leaves --all alone for any other command', () => {
        expect(configureHelp(program(), ['node', 'rigour', 'review', '--all'])).toEqual(['node', 'rigour', 'review', '--all']);
    });
});
