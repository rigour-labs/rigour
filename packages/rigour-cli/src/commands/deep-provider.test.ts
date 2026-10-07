import { describe, expect, it } from 'vitest';
import { deepProvider } from './deep-provider.js';
import { UsageError } from './review-config.js';

describe('deepProvider', () => {
    it('uses the resolved provider when there is a key', () => {
        expect(deepProvider('openrouter', 'openrouter', 'k')).toEqual({ provider: 'openrouter', apiKey: 'k' });
        expect(deepProvider(undefined, undefined, 'k')).toEqual({ provider: 'claude', apiKey: 'k' });
    });

    it('refuses a named cloud provider with no key instead of switching to the local model', () => {
        expect(() => deepProvider('openrouter', 'openrouter', undefined)).toThrow(UsageError);
        expect(() => deepProvider('openrouter', 'openrouter', undefined)).toThrow(/RIGOUR_API_KEY/);
    });

    it('runs the built-in model when no provider was named, and a model server on this machine when one was', () => {
        expect(deepProvider(undefined, 'anthropic', undefined)).toEqual({ provider: 'local' });
        expect(deepProvider('local', 'local', undefined)).toEqual({ provider: 'local' });
        expect(deepProvider('Ollama', 'ollama', undefined)).toEqual({ provider: 'ollama', apiKey: 'ollama' });
        expect(deepProvider('lmstudio', 'lmstudio', undefined)).toEqual({ provider: 'lmstudio', apiKey: 'lmstudio' });
    });
});
