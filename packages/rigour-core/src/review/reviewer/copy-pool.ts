/**
 * The copies one review's judges run code in: at most two, whatever the number of orchestrated passes. A pass takes a
 * free copy, reset to the reviewed commit with nothing the last judge wrote, or makes one while there are fewer than
 * two; otherwise it waits. Why two: disk stays bounded at twice one copy however many passes run (the disk is often
 * nearly full), two passes still run at once, and a reset copy keeps each pass's scratch files from the next. After each
 * run the judge and everything it started are ended (judge-processes.ts); when the review ends, or Rigour is
 * interrupted, every copy is removed with what each CLI kept under its path (cli-leftovers.ts).
 */
import type { Exec } from './exec.js';
import { codexHomeOf, removeClaudeLeftovers, removeCodexTrust } from './cli-leftovers.js';
import { alive, endJudgeProcesses } from './judge-processes.js';
import { watchJudge } from './judge-watchdog.js';
import { onTermination } from './on-termination.js';
import { makeCopy, removeCopy, resetCopy, type Copy } from './throwaway-copy.js';

export const MAX_COPIES = 2;

interface Slot { copy: Copy; busy: boolean; pid?: number }

export interface CopyPool {
    /** Runs `work` in a copy, handing it a place to record the judge's pid; a copy that cannot be had is an error. */
    run<T>(work: (dir: string, started: (pid: number) => void) => Promise<T>, judgeEnv?: Record<string, string>): Promise<T | { error: string }>;
    /** Removes every copy and what the CLIs kept under it. */
    close(): void;
}

export function copyPool(cwd: string, head: string, exec: Exec, note: (line: string) => void = line => process.stderr.write(`${line}\n`), max = MAX_COPIES): CopyPool {
    const slots: Slot[] = [];
    const waiting: Array<() => void> = [];
    const codexHomes = new Set<string>([codexHomeOf(undefined)]);
    /** Every copy this review made, for what the CLIs kept under its path. */
    const made = new Set<string>();
    let making = 0;
    const removeAll = () => {
        for (const slot of slots) {
            endJudgeProcesses(slot.pid, slot.copy.dir);
            removeCopy(slot.copy);
        }
        slots.length = 0;
        for (const dir of made) removeClaudeLeftovers(dir);
        for (const home of codexHomes) {
            const left = removeCodexTrust(home, project => made.has(project));
            if (left) note(`Rigour reviewer: ${left}`);
        }
    };
    const unregister = onTermination(removeAll);
    const acquire = async (): Promise<Slot | { error: string }> => {
        for (;;) {
            const free = slots.find(slot => !slot.busy);
            if (free) {
                free.busy = true;
                const failed = await resetCopy(cwd, free.copy, head, exec);
                if (!failed) return free;
                // A copy that cannot be reset is no one's: removed, so the next pass makes a new one.
                slots.splice(slots.indexOf(free), 1);
                removeCopy(free.copy);
                waiting.shift()?.();
                return { error: `could not reset the throwaway copy: ${failed}` };
            }
            if (slots.length + making < max) {
                making++;
                const copy = await makeCopy(cwd, head, exec).finally(() => making--);
                if ('error' in copy) return copy;
                made.add(copy.dir);
                const slot: Slot = { copy, busy: true };
                slots.push(slot);
                return slot;
            }
            await new Promise<void>(resolve => waiting.push(resolve));
        }
    };
    return {
        async run(work, judgeEnv) {
            codexHomes.add(codexHomeOf(judgeEnv));
            const slot = await acquire();
            if ('error' in slot) return slot;
            let stopWatch = () => undefined as void;
            try {
                return await work(slot.copy.dir, pid => {
                    slot.pid = pid;
                    stopWatch = watchJudge(pid, slot.copy.dir);
                });
            } finally {
                endJudgeProcesses(slot.pid, slot.copy.dir);
                for (let i = 0; slot.pid && i < 40 && alive(slot.pid); i++) await new Promise(resolve => setTimeout(resolve, 50));
                stopWatch();
                slot.pid = undefined;
                slot.busy = false;
                waiting.shift()?.();
            }
        },
        close() {
            removeAll();
            unregister();
        },
    };
}
