/**
 * Cleanup that must happen even when Rigour itself is interrupted: a SIGINT (Ctrl-C) or a SIGTERM (a newer push ending
 * a background review) runs every registered cleanup, synchronously, then exits as the signal would (130, 143).
 */

/** What a SIGINT or SIGTERM must still clean up: each entry removes one copy, one worktree or ends one judge, synchronously. */
const cleanups = new Set<() => void>();
const SIGNALS: Array<[NodeJS.Signals, number]> = [['SIGINT', 130], ['SIGTERM', 143]];
const onSignal = (signal: NodeJS.Signals) => {
    for (const cleanup of [...cleanups]) cleanup();
    process.exit(SIGNALS.find(([name]) => name === signal)?.[1] ?? 1);
};

/** Runs `cleanup` if Rigour is interrupted before the returned function is called (which unregisters it). */
export function onTermination(cleanup: () => void): () => void {
    if (cleanups.size === 0) for (const [signal] of SIGNALS) process.on(signal, onSignal);
    cleanups.add(cleanup);
    return () => {
        cleanups.delete(cleanup);
        if (cleanups.size === 0) for (const [signal] of SIGNALS) process.off(signal, onSignal);
    };
}
