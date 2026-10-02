import { describe, expect, it } from 'vitest';
import { createStudioGuard, refuseStudioRequest, STUDIO_KEY_HEADER, studioLaunchUrl } from './studio-guard.js';

const guard = createStudioGuard([3000, 3001]);
const req = (method: string, headers: Record<string, string>) => ({ method, headers });

describe('Studio request guard', () => {
    it('serves reads only to its own loopback host, so a rebound DNS name cannot read files', () => {
        expect(refuseStudioRequest(req('GET', { host: '127.0.0.1:3000' }), guard)).toBeNull();
        expect(refuseStudioRequest(req('GET', { host: 'localhost:3001' }), guard)).toBeNull();
        expect(refuseStudioRequest(req('GET', { host: 'attacker.example:3000' }), guard)).toBe('unknown host');
        expect(refuseStudioRequest(req('GET', {}), guard)).toBe('unknown host');
    });

    it('accepts a write only with the launch key and no foreign origin', () => {
        const host = { host: '127.0.0.1:3000' };
        expect(refuseStudioRequest(req('POST', { ...host, [STUDIO_KEY_HEADER]: guard.launchKey }), guard)).toBeNull();
        expect(refuseStudioRequest(req('POST', { ...host, origin: 'http://127.0.0.1:3000', [STUDIO_KEY_HEADER]: guard.launchKey }), guard)).toBeNull();
        expect(refuseStudioRequest(req('POST', host), guard)).toContain('missing studio key');
        expect(refuseStudioRequest(req('DELETE', { ...host, [STUDIO_KEY_HEADER]: 'x'.repeat(48) }), guard)).toContain('wrong studio key');
        expect(refuseStudioRequest(req('POST', { ...host, origin: 'https://evil.example', [STUDIO_KEY_HEADER]: guard.launchKey }), guard)).toBe('cross-origin write');
    });

    it('puts the key in the fragment, which the browser never sends to a server', () => {
        expect(studioLaunchUrl('http://127.0.0.1:3000', guard)).toBe(`http://127.0.0.1:3000/#key=${guard.launchKey}`);
        expect(createStudioGuard([3000]).launchKey).not.toBe(guard.launchKey);
    });
});
