import { describe, it, expect } from 'vitest';
import { GateRunner } from '../src/gates/runner.js';

describe('GateRunner Smoke Test', () => {
    it('should initialize with empty config', async () => {
        const config = {
            version: 1,
            commands: {},
            gates: {
                max_file_lines: 500,
                forbid_todos: true,
                forbid_fixme: true,
            },
        };
        const runner = new GateRunner(config as any);
        expect(runner).toBeDefined();
    });
});
