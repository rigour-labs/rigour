/**
 * Per-function facts, computed once and reused by every caller.
 *
 * Rules decide what a fact is (for example "parameter 2 reaches a fetch that
 * may follow redirects"); this store only memoizes them and breaks recursion:
 * a function whose fact is being computed further up the stack answers with
 * the rule's empty value, which never produces a finding.
 */
import type ts from 'typescript';
import type { FunctionLike } from './ast.js';

export class Summaries {
    private readonly values = new Map<string, WeakMap<FunctionLike, unknown>>();
    private readonly active = new Map<string, Set<FunctionLike>>();

    constructor(readonly checker: ts.TypeChecker) { }

    memo<T>(kind: string, fn: FunctionLike, empty: T, compute: () => T): T {
        const byFn = this.table(this.values, kind, () => new WeakMap<FunctionLike, unknown>());
        if (byFn.has(fn)) return byFn.get(fn) as T;

        const running = this.table(this.active, kind, () => new Set<FunctionLike>());
        if (running.has(fn)) return empty;
        running.add(fn);
        try {
            const value = compute();
            byFn.set(fn, value);
            return value;
        } finally {
            running.delete(fn);
        }
    }

    private table<V>(map: Map<string, V>, kind: string, create: () => V): V {
        let entry = map.get(kind);
        if (!entry) {
            entry = create();
            map.set(kind, entry);
        }
        return entry;
    }
}
