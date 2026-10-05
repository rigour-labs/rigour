import { describe, expect, it } from 'vitest';
import { deepProvider } from './deep-provider.js';
import { UsageError } from './review-config.js';

describe('deepProvider', () => {
    it('uses the resolved provider when there is a key', () => {
        expect(deepProvider('openrouter', 'openrouter', 'k')).toBe('openrouter');
        expect(deepProvider(undefined, undefined, 'k')).toBe('claude');
    });

    it('refuses a named cloud provider with no key instead of switching to the local model', () => {
        expect(() => deepProvider('openrouter', 'openrouter', undefined)).toThrow(UsageError);
        expect(() => deepProvider('openrouter', 'openrouter', undefined)).toThrow(/RIGOUR_API_KEY/);
    });

    it('runs locally when no provider was named, or a keyless one was', () => {
        expect(deepProvider(undefined, 'anthropic', undefined)).toBe('local');
        expect(deepProvider('local', 'local', undefined)).toBe('local');
        expect(deepProvider('Ollama', 'ollama', undefined)).toBe('local');
    });
});
