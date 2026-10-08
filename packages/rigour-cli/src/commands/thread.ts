/**
 * `rigour thread [key]`: the thread of one engineering task, everything Rigour saw happen to it in order. The key is a
 * ticket (`PROJ-123`), a branch, or a pull request (`#42`); without one, the checkout's own task.
 */
import chalk from 'chalk';
import { readThread, threadText } from '@rigour-labs/core';

export function threadCommand(cwd: string, key: string | undefined, options: { json?: boolean }): number {
    const thread = readThread(cwd, key);
    if (!thread) {
        const what = key ? `no thread for ${key}` : 'no task here: the checkout is on a detached head';
        if (options.json) console.log(JSON.stringify({ task: key ?? null, events: [], error: what }, null, 2));
        else console.error(chalk.yellow(`${what}. A thread starts when a hooked agent edits, a stop review or push gate runs, or a review runs on a branch.`));
        return 1;
    }
    if (options.json) {
        console.log(JSON.stringify(thread, null, 2));
        return 0;
    }
    const [head, ...rest] = threadText(thread);
    console.log(chalk.bold(head));
    for (const line of rest) console.log(line.startsWith('  ') ? chalk.dim(line) : line);
    return 0;
}
