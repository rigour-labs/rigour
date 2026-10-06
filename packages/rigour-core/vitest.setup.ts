import fs from 'fs';
import os from 'os';
import path from 'path';
import { vi } from 'vitest';

// Always a throwaway home, never the developer's or CI's own (a real RIGOUR_HOME would steer every test), and no
// reviewer choice from the shell: the environment layer of the reviewer settings is set by a test that means it.
delete process.env.RIGOUR_REVIEWER_MODE;
delete process.env.RIGOUR_REVIEWER_PANEL;
// State Rigour keeps outside the workspace (~/.rigour) goes to a throwaway home in tests, never the real one.
process.env.RIGOUR_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rigour-home-'));
// And the person's own profiles (~/.rigour/profiles.json) never steer a test.
process.env.RIGOUR_PROFILES = path.join(process.env.RIGOUR_HOME, 'no-profiles.json');
// Agents' user-level configs (~/.claude, ~/.cursor, ...) go to a throwaway home too: os.homedir() ignores a
// HOME a test sets inside a worker thread, so nothing reaches the real one unless a test points here itself.
process.env.RIGOUR_AGENT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rigour-agent-home-'));
// And no test ever runs the person's real Claude Code CLI.
process.env.RIGOUR_CLAUDE_CLI = path.join(process.env.RIGOUR_AGENT_HOME, 'no-claude-cli');

// Mock Transformers.js to avoid native binary dependency issues and speed up tests
vi.mock('@xenova/transformers', () => ({
    pipeline: async () => {
        // Return a mock extractor that produces deterministic "embeddings"
        return async (text: string) => {
            // Create a fake vector based on the text length or hash
            const vector = new Array(384).fill(0);
            for (let i = 0; i < Math.min(text.length, 384); i++) {
                vector[i] = text.charCodeAt(i) / 255;
            }
            return { data: new Float32Array(vector) };
        };
    },
    env: {
        allowImageProcessors: false,
    },
}));

// Also mock sharp just in case something else pulls it in
vi.mock('sharp', () => ({
    default: () => ({
        resize: () => ({
            toFormat: () => ({
                toBuffer: async () => Buffer.from([]),
            }),
        }),
    }),
}));
