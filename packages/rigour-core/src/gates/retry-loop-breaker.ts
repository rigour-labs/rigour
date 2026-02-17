import { Gate, GateContext } from './base.js';
import { Failure, Gates, Provenance } from '../types/index.js';
import fs from 'fs-extra';
import path from 'path';

interface FailureRecord {
    category: string;
    count: number;
    lastError: string;
    lastTimestamp: string;
}

interface RigourState {
    failureHistory: Record<string, FailureRecord>;
}

const ERROR_PATTERNS: [RegExp, string][] = [
    [/ERR_REQUIRE_ESM|Cannot find module|MODULE_NOT_FOUND/i, 'module_resolution'],
    [/FUNCTION_INVOCATION_FAILED|Build Failed|deploy.*fail/i, 'deployment'],
    [/TypeError|SyntaxError|ReferenceError|compilation.*error/i, 'runtime_error'],
    [/Connection refused|ECONNREFUSED|timeout|ETIMEDOUT/i, 'network'],
    [/Permission denied|EACCES|EPERM/i, 'permissions'],
    [/ENOMEM|heap out of memory|OOM/i, 'resources'],
];

/**
 * Retry Loop Breaker Gate
 * 
 * Detects when an agent is stuck in a retry loop and forces them to consult
 * official documentation before continuing. This gate is universal and works
 * with any type of failure, not just specific tools or languages.
 */
export class RetryLoopBreakerGate extends Gate {
    constructor(private options: Gates['retry_loop_breaker']) {
        super('retry_loop_breaker', 'Retry Loop Breaker');
    }

    protected get provenance(): Provenance { return 'governance'; }

    async run(context: GateContext): Promise<Failure[]> {
        const state = await this.loadState(context.cwd);
        const failures: Failure[] = [];

        for (const [category, record] of Object.entries(state.failureHistory)) {
            if (record.count >= (this.options?.max_retries ?? 3)) {
                const docUrl = this.options?.doc_sources?.[category] || this.getDefaultDocUrl(category);
                failures.push(this.createFailure(
                    `Operation '${category}' has failed ${record.count} times consecutively. Last error: ${record.lastError}`,
                    undefined,
                    `STOP RETRYING. You are in a loop. Consult the official documentation: ${docUrl}. Extract the canonical solution pattern and apply it.`,
                    `Retry Loop Detected: ${category}`,
                    undefined,
                    undefined,
                    'critical'
                ));
            }
        }

        return failures;
    }

    /**
     * Classify an error message into a category based on patterns.
     */
    static classifyError(errorMessage: string): string {
        for (const [pattern, category] of ERROR_PATTERNS) {
            if (pattern.test(errorMessage)) {
                return category;
            }
        }
        return 'general';
    }

    /**
     * Record a failure for retry loop detection.
     * Call this when an operation fails.
     */
    static async recordFailure(cwd: string, errorMessage: string, category?: string): Promise<void> {
        const resolvedCategory = category || this.classifyError(errorMessage);
        const state = await this.loadStateStatic(cwd);

        const existing = state.failureHistory[resolvedCategory] || {
            category: resolvedCategory,
            count: 0,
            lastError: '',
            lastTimestamp: ''
        };
        existing.count += 1;
        existing.lastError = errorMessage.slice(0, 500); // Truncate for storage
        existing.lastTimestamp = new Date().toISOString();
        state.failureHistory[resolvedCategory] = existing;

        await this.saveStateStatic(cwd, state);
    }

    /**
     * Clear failure history for a specific category after successful resolution.
     */
    static async clearFailure(cwd: string, category: string): Promise<void> {
        const state = await this.loadStateStatic(cwd);
        delete state.failureHistory[category];
        await this.saveStateStatic(cwd, state);
    }

    /**
     * Clear all failure history.
     */
    static async clearAllFailures(cwd: string): Promise<void> {
        const state = await this.loadStateStatic(cwd);
        state.failureHistory = {};
        await this.saveStateStatic(cwd, state);
    }

    /**
     * Get the current failure state for inspection.
     */
    static async getState(cwd: string): Promise<RigourState> {
        return this.loadStateStatic(cwd);
    }

    private getDefaultDocUrl(category: string): string {
        const defaults: Record<string, string> = {
            module_resolution: 'https://nodejs.org/api/esm.html',
            deployment: 'Check the deployment platform\'s official documentation',
            runtime_error: 'Check the language\'s official documentation',
            network: 'Check network configuration and firewall rules',
            permissions: 'Check file/directory permissions and ownership',
            resources: 'Check system resource limits and memory allocation',
            general: 'Consult the relevant official documentation',
        };
        return defaults[category] || defaults.general;
    }

    private async loadState(cwd: string): Promise<RigourState> {
        return RetryLoopBreakerGate.loadStateStatic(cwd);
    }

    private static async loadStateStatic(cwd: string): Promise<RigourState> {
        const statePath = path.join(cwd, '.rigour', 'state.json');
        if (await fs.pathExists(statePath)) {
            try {
                const data = await fs.readJson(statePath);
                return { failureHistory: data.failureHistory || {}, ...data };
            } catch {
                return { failureHistory: {} };
            }
        }
        return { failureHistory: {} };
    }

    private static async saveStateStatic(cwd: string, state: RigourState): Promise<void> {
        const statePath = path.join(cwd, '.rigour', 'state.json');
        await fs.ensureDir(path.dirname(statePath));
        await fs.writeJson(statePath, state, { spaces: 2 });
    }
}
