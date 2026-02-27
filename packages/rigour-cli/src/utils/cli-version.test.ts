import { describe, expect, it } from 'vitest';
import { getCliVersion } from './cli-version.js';

describe('getCliVersion', () => {
    it('resolves package version at runtime', () => {
        const version = getCliVersion();
        expect(version).toMatch(/^\d+\.\d+\.\d+/);
        expect(version).not.toBe('0.0.0');
    });
});

