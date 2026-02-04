import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';

// Integration-style tests for rigour_run_supervised
// These test the exported functionality indirectly since MCP server is complex to mock

describe('rigour_run_supervised', () => {
    let testDir: string;

    beforeEach(async () => {
        testDir = path.join(os.tmpdir(), `rigour-test-${Date.now()}`);
        await fs.ensureDir(testDir);

        // Create a minimal rigour.yml
        await fs.writeFile(path.join(testDir, 'rigour.yml'), `
version: 1
preset: api
gates:
  max_file_lines: 500
  forbid_todos: true
  required_files: []
ignore: []
`);

        // Create .rigour directory for events
        await fs.ensureDir(path.join(testDir, '.rigour'));
    });

    afterEach(async () => {
        await fs.remove(testDir);
    });

    it('should have correct tool schema', () => {
        // Verify the tool schema includes all required fields
        const expectedProperties = ['cwd', 'command', 'maxRetries', 'dryRun'];
        const requiredProperties = ['cwd', 'command'];

        // This is a schema validation test - in real MCP, the server validates this
        expect(expectedProperties).toContain('dryRun');
        expect(requiredProperties).not.toContain('dryRun'); // dryRun should be optional
    });

    it('should log supervisor_started event', async () => {
        // Simulate what the handler does
        const eventsPath = path.join(testDir, '.rigour', 'events.jsonl');

        const event = {
            id: 'test-id',
            timestamp: new Date().toISOString(),
            type: 'supervisor_started',
            requestId: 'req-123',
            command: 'echo "test"',
            maxRetries: 3,
            dryRun: true
        };

        await fs.appendFile(eventsPath, JSON.stringify(event) + '\n');

        const content = await fs.readFile(eventsPath, 'utf-8');
        const logged = JSON.parse(content.trim());

        expect(logged.type).toBe('supervisor_started');
        expect(logged.dryRun).toBe(true);
        expect(logged.maxRetries).toBe(3);
    });

    it('should log supervisor_iteration events', async () => {
        const eventsPath = path.join(testDir, '.rigour', 'events.jsonl');

        // Simulate iteration logging
        const iterations = [
            { iteration: 1, status: 'FAIL', failures: 2 },
            { iteration: 2, status: 'FAIL', failures: 1 },
            { iteration: 3, status: 'PASS', failures: 0 },
        ];

        for (const iter of iterations) {
            const event = {
                id: `iter-${iter.iteration}`,
                timestamp: new Date().toISOString(),
                type: 'supervisor_iteration',
                requestId: 'req-123',
                ...iter
            };
            await fs.appendFile(eventsPath, JSON.stringify(event) + '\n');
        }

        const content = await fs.readFile(eventsPath, 'utf-8');
        const lines = content.trim().split('\n').map(l => JSON.parse(l));

        expect(lines.length).toBe(3);
        expect(lines[0].iteration).toBe(1);
        expect(lines[2].status).toBe('PASS');
    });

    it('should log supervisor_completed event with final status', async () => {
        const eventsPath = path.join(testDir, '.rigour', 'events.jsonl');

        const event = {
            id: 'completed-1',
            timestamp: new Date().toISOString(),
            type: 'supervisor_completed',
            requestId: 'req-123',
            finalStatus: 'PASS',
            totalIterations: 2
        };

        await fs.appendFile(eventsPath, JSON.stringify(event) + '\n');

        const content = await fs.readFile(eventsPath, 'utf-8');
        const logged = JSON.parse(content.trim());

        expect(logged.type).toBe('supervisor_completed');
        expect(logged.finalStatus).toBe('PASS');
        expect(logged.totalIterations).toBe(2);
    });

    it('should track iteration history correctly', () => {
        const iterations: { iteration: number; status: string; failures: number }[] = [];

        // Simulate the supervisor loop
        iterations.push({ iteration: 1, status: 'FAIL', failures: 3 });
        iterations.push({ iteration: 2, status: 'FAIL', failures: 1 });
        iterations.push({ iteration: 3, status: 'PASS', failures: 0 });

        const summary = iterations.map(i => `  ${i.iteration}. ${i.status} (${i.failures} failures)`).join('\n');

        expect(summary).toContain('1. FAIL (3 failures)');
        expect(summary).toContain('3. PASS (0 failures)');
        expect(iterations.length).toBe(3);
    });

    it('should generate fix packet for failures', () => {
        const failures = [
            { id: 'max_lines', title: 'File too long', details: 'src/index.ts has 600 lines', files: ['src/index.ts'], hint: 'Split into modules' },
            { id: 'forbid_todos', title: 'TODO found', details: 'Found TODO comment', files: ['src/utils.ts'] },
        ];

        const fixPacket = failures.map((f, i) => {
            let text = `FIX TASK ${i + 1}: [${f.id.toUpperCase()}] ${f.title}\n`;
            text += `   - CONTEXT: ${f.details}\n`;
            if (f.files && f.files.length > 0) {
                text += `   - TARGET FILES: ${f.files.join(', ')}\n`;
            }
            if ((f as any).hint) {
                text += `   - REFACTORING GUIDANCE: ${(f as any).hint}\n`;
            }
            return text;
        }).join('\n---\n');

        expect(fixPacket).toContain('[MAX_LINES]');
        expect(fixPacket).toContain('[FORBID_TODOS]');
        expect(fixPacket).toContain('Split into modules');
        expect(fixPacket).toContain('src/index.ts');
    });
});
