import { describe, expect, it } from 'vitest';
import yaml from 'yaml';
import { ConfigSchema } from './index.js';

describe('rigour.yml', () => {
    it('still loads a file that sets the settings no check ever read, and keeps everything else', () => {
        const old = yaml.parse(`
version: 1
planned: [Layer boundaries]
hooks: { enabled: true, tools: [claude], fast_gates: [file-size], timeout_ms: 5000, block_on_failure: true, dlp: false, require_review_ack: true }
gates:
  max_file_lines: 300
  forbid_paths: [secret/]
  ast: { complexity: 7, max_nesting: 3, max_function_lines: 40 }
  adaptive: { enabled: true, forced_tier: enterprise }
  input_validation: { enabled: true, min_secret_length: 12 }
  deep: { enabled: true, provider: claude, api_key: sk-test, model_name: x, threads: 8, temperature: 0.2 }
  test_quality: { check_snapshot_abuse: false, ignore_patterns: [x], max_mocks_per_test: 3 }
`);
        const config = ConfigSchema.parse(old);
        expect(config.gates.max_file_lines).toBe(300);
        expect(config.gates.ast.complexity).toBe(7);
        expect(config.gates.deep.temperature).toBe(0.2);
        expect(config.gates.test_quality.max_mocks_per_test).toBe(3);
        expect(config.hooks.require_review_ack).toBe(true);
        // What nothing read is dropped, so no code can start depending on it by accident.
        expect(config).not.toHaveProperty('version');
        expect(config).not.toHaveProperty('planned');
        expect(config.gates).not.toHaveProperty('adaptive');
        expect(config.gates).not.toHaveProperty('input_validation');
        expect(config.gates.deep).not.toHaveProperty('api_key');
        expect(config.hooks).not.toHaveProperty('block_on_failure');
    });
});
