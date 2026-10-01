import { describe, expect, it } from 'vitest';
import { funnelText } from './DeepAnalysis';

describe('DeepAnalysis funnel', () => {
    it('shows where the model findings went, with rejection reasons', () => {
        expect(funnelText({ enabled: true, findings_proposed: 9, findings_withdrawn: 3, findings_rejected: { ungrounded_identifier: 1, out_of_range: 1 }, findings_count: 4 }))
            .toBe('9 proposed → 3 withdrawn by self-check → 2 rejected by grounding (ungrounded identifier 1, out of range 1) → 4 kept');
        expect(funnelText({ enabled: true })).toBeNull();
    });
});
