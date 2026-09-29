import { describe, expect, it } from 'vitest';
import { buildLlamaArgs, cleanLlamaOutput, contextSizeFor, runProcess } from './llama-process.js';

const base = { modelPath: '/m.gguf', prompt: 'hello', maxTokens: 1024, threads: 4, temperature: 0.1 };

describe('buildLlamaArgs', () => {
    it('uses flags llama.cpp b5604 accepts and that keep generated text on stdout', () => {
        const args = buildLlamaArgs(base);
        expect(args).toContain('-st');
        expect(args).toContain('--simple-io');
        expect(args).toContain('--no-display-prompt');
        expect(args).not.toContain('--json');
        expect(args).not.toContain('--log-disable');
    });

    it('fixes the seed so a run is reproducible', () => {
        const args = buildLlamaArgs(base);
        expect(args[args.indexOf('--seed') + 1]).toBe('42');
    });

    it('constrains output with the findings schema file when given', () => {
        const args = buildLlamaArgs({ ...base, schemaPath: '/schema.json' });
        expect(args.slice(-2)).toEqual(['--json-schema-file', '/schema.json']);
        expect(buildLlamaArgs(base)).not.toContain('--json-schema-file');
    });

    it('passes a context size that fits the prompt', () => {
        const args = buildLlamaArgs({ ...base, prompt: 'x'.repeat(30_000) });
        expect(Number(args[args.indexOf('--ctx-size') + 1])).toBe(contextSizeFor('x'.repeat(30_000), 1024));
    });
});

describe('contextSizeFor', () => {
    it('never goes below the 4096 default', () => {
        expect(contextSizeFor('short', 512)).toBe(4096);
    });

    it('grows with the prompt, rounded up to 1024', () => {
        const size = contextSizeFor('x'.repeat(30_000), 1024);
        expect(size).toBeGreaterThanOrEqual(10_000 + 1024);
        expect(size % 1024).toBe(0);
    });

    it('is capped at the model training context', () => {
        expect(contextSizeFor('x'.repeat(1_000_000), 1024)).toBe(32768);
    });
});

describe('cleanLlamaOutput', () => {
    it('strips the end-of-generation marker', () => {
        expect(cleanLlamaOutput('{"findings": []} [end of text]\n\n')).toBe('{"findings": []}');
    });
});

describe('runProcess', () => {
    it('collects stdout and stderr and returns the exit code', async () => {
        const result = await runProcess(process.execPath, ['-e', 'process.stdout.write("out");process.stderr.write("err");process.exit(3)'], { timeoutMs: 10_000 });
        expect(result).toEqual({ code: 3, stdout: 'out', stderr: 'err' });
    });

    it('runs with stdin closed so an interactive binary cannot wait on it', async () => {
        const result = await runProcess(process.execPath, ['-e', 'process.stdin.on("end",()=>process.stdout.write("eof")).resume()'], { timeoutMs: 10_000 });
        expect(result.stdout).toBe('eof');
    });

    it('kills and rejects on timeout', async () => {
        await expect(runProcess(process.execPath, ['-e', 'setTimeout(()=>{}, 10_000)'], { timeoutMs: 100 }))
            .rejects.toThrow('timed out');
    });

    it('rejects when the binary cannot be spawned', async () => {
        await expect(runProcess('/nonexistent/llama-cli', [], { timeoutMs: 1_000 })).rejects.toThrow();
    });
});
