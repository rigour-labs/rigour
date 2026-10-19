/**
 * Which check each blocking finding came from, by the check's id as the report's summary names it: a gate's id, the
 * review's own check that produced it, or `goal`. A finding is matched through its stable key, so a copy made on the
 * way (a finding re-anchored to a changed line) still finds its check. What cannot be tied to a check is counted
 * under its own rule id, which the summary may not name.
 */
import { gateOf } from '../gates/runner.js';
import type { Failure } from '../types/index.js';
import { findingKey } from './quiet.js';

export function blockingByCheck(blocking: Failure[], produced: Failure[], owner: Map<Failure, string>): Record<string, number> {
    const checkOf = (f: Failure) => owner.get(f) ?? gateOf(f) ?? f.id;
    const byKey = new Map(produced.map(f => [findingKey(f), checkOf(f)]));
    const counts: Record<string, number> = {};
    for (const f of blocking) {
        const check = byKey.get(findingKey(f)) ?? checkOf(f);
        counts[check] = (counts[check] ?? 0) + 1;
    }
    return counts;
}
