import { describe, expect, it } from 'vitest';
import { GateRunner } from '../gates/runner.js';
import { ConfigSchema } from '../types/index.js';
import { telemetryCheckId } from './check-ids.js';

describe('the check ids telemetry may send', () => {
    it('includes every gate the registry builds, with every optional gate on', () => {
        const config = ConfigSchema.parse({
            version: 1,
            commands: { lint: 'npm run lint', 'acme-billing-guard': 'node scripts/acme.js' },
            gates: {
                unindexed_reads: { enabled: true }, retry_loop_breaker: { enabled: true }, agent_team: { enabled: true }, checkpoint: { enabled: true },
                coverage: { enabled: true }, frontend_secret_exposure: { enabled: true }, environment: { enabled: true }, dependencies: { enabled: true },
            },
        });
        const ids = ((new GateRunner(config) as unknown as { gates: Array<{ id: string }> }).gates).map(g => g.id);
        expect(ids.length).toBeGreaterThan(10);
        expect(ids.filter(id => telemetryCheckId(id) === 'custom')).toEqual([]);
    });

    it('sends a team\'s own check only as custom', () => {
        expect(telemetryCheckId('acme-billing-guard')).toBe('custom');
        expect(telemetryCheckId('semantic-bugs')).toBe('semantic-bugs');
    });
});
