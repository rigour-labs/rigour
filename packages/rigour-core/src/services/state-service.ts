import fs from 'fs-extra';
import path from 'path';
import crypto from 'crypto';

/**
 * Local Calibration State Service
 * 
 * DOCTRINE COMPLIANCE (§6):
 * - Local-only, deletable, optional
 * - Used ONLY for prioritization, ordering, early warnings
 * - NEVER stores: source code, file contents, raw paths, prompts, user identifiers
 * - State NEVER changes PASS/FAIL results (only ordering/messaging)
 */

interface ViolationStats {
    count: number;
    lastSeen: string; // ISO timestamp
    coOccurs: Record<string, number>; // Rule ID -> co-occurrence count
}

interface LocalState {
    version: number;
    createdAt: string;
    violations: Record<string, ViolationStats>; // Rule ID -> stats
}

const STATE_DIR = '.rigour';
const STATE_FILE = 'state.json';
const CURRENT_VERSION = 1;

export class StateService {
    private statePath: string;
    private state: LocalState;

    constructor(cwd: string) {
        this.statePath = path.join(cwd, STATE_DIR, STATE_FILE);
        this.state = this.load();
    }

    private load(): LocalState {
        try {
            if (fs.existsSync(this.statePath)) {
                const content = fs.readFileSync(this.statePath, 'utf-8');
                return JSON.parse(content);
            }
        } catch {
            // Corrupted or missing state - reset
        }
        return this.createEmpty();
    }

    private createEmpty(): LocalState {
        return {
            version: CURRENT_VERSION,
            createdAt: new Date().toISOString(),
            violations: {},
        };
    }

    /**
     * Record violation occurrences for prioritization.
     * PRIVACY: Only stores rule IDs and counts, never file contents or paths.
     */
    recordViolations(ruleIds: string[]): void {
        const now = new Date().toISOString();

        for (const ruleId of ruleIds) {
            if (!this.state.violations[ruleId]) {
                this.state.violations[ruleId] = { count: 0, lastSeen: now, coOccurs: {} };
            }
            this.state.violations[ruleId].count++;
            this.state.violations[ruleId].lastSeen = now;

            // Track co-occurrences for pattern detection
            for (const otherId of ruleIds) {
                if (otherId !== ruleId) {
                    this.state.violations[ruleId].coOccurs[otherId] =
                        (this.state.violations[ruleId].coOccurs[otherId] || 0) + 1;
                }
            }
        }
    }

    /**
     * Prioritize violations for Fix Packet ordering.
     * Most frequent + recent violations appear first.
     */
    prioritize(ruleIds: string[]): string[] {
        return [...ruleIds].sort((a, b) => {
            const statsA = this.state.violations[a];
            const statsB = this.state.violations[b];

            if (!statsA && !statsB) return 0;
            if (!statsA) return 1;
            if (!statsB) return -1;

            // Higher count = higher priority
            return statsB.count - statsA.count;
        });
    }

    /**
     * Get repeat violation hints for agent feedback.
     */
    getRepeatHints(ruleIds: string[]): Record<string, string> {
        const hints: Record<string, string> = {};

        for (const ruleId of ruleIds) {
            const stats = this.state.violations[ruleId];
            if (stats && stats.count > 2) {
                hints[ruleId] = `This violation has occurred ${stats.count} times. Consider root-cause analysis.`;
            }
        }

        return hints;
    }

    save(): void {
        try {
            fs.ensureDirSync(path.dirname(this.statePath));
            fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
        } catch {
            // Silent fail - state is optional
        }
    }

    /**
     * Clear all state (user privacy action).
     */
    clear(): void {
        this.state = this.createEmpty();
        try {
            fs.removeSync(this.statePath);
        } catch {
            // Silent fail
        }
    }
}
