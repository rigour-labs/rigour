/** Studio's Check precision view: each check's posterior here, and the rule that mutes a check. */
import { checkPrecisions, MUTE_BELOW, MUTE_MIN_OUTCOMES, type CheckPrecision } from '@rigour-labs/core';

export interface StudioCheckPrecision {
    checks: CheckPrecision[];
    muteBelow: number;
    muteMinOutcomes: number;
}

export function loadStudioCheckPrecision(cwd: string): StudioCheckPrecision {
    return { checks: checkPrecisions(cwd), muteBelow: MUTE_BELOW, muteMinOutcomes: MUTE_MIN_OUTCOMES };
}
