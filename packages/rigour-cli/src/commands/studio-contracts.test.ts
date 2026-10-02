import { describe, expect, it } from 'vitest';
import { resolveStudioVersion } from './studio-contracts.js';

describe('resolveStudioVersion', () => {
    it('prefers the released CLI version used to serve Studio', () => {
        expect(resolveStudioVersion('6.2.1', '5.4.0')).toBe('6.2.1');
        expect(resolveStudioVersion(undefined, '6.2.0')).toBe('6.2.0');
    });
});
