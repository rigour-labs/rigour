import { Gate, GateContext } from './base.js';
import { Failure, Gates } from '../types/index.js';
import { execa } from 'execa';

export class FileGuardGate extends Gate {
    constructor(private config: Gates) {
        super('file-guard', 'File Guard — Protected Paths');
    }

    async run(context: GateContext): Promise<Failure[]> {
        const failures: Failure[] = [];
        const safety = this.config.safety || {};
        const protectedPaths = safety.protected_paths || [];

        if (protectedPaths.length === 0) return [];

        try {
            // Check for modified files in protected paths using git
            // File Guard - if an agent touched protected files, we fail.
            const { stdout } = await execa('git', ['status', '--porcelain'], { cwd: context.cwd });
            const modifiedFiles = stdout.split('\n')
                .filter(line => {
                    const status = line.slice(0, 2);
                    // M: Modified, A: Added (staged), D: Deleted, R: Renamed
                    // We ignore ?? (Untracked) to allow rigour init and new doc creation
                    return /M|A|D|R/.test(status);
                })
                .map(line => line.slice(3).trim());

            for (const file of modifiedFiles) {
                if (this.isProtected(file, protectedPaths)) {
                    const message = `Protected file '${file}' was modified.`;
                    failures.push(this.createFailure(
                        message,
                        [file],
                        `Agents are forbidden from modifying files in ${protectedPaths.join(', ')}.`,
                        message
                    ));
                }
            }
        } catch (error) {
            // If not a git repo, skip safety for now
        }

        return failures;
    }

    private isProtected(file: string, patterns: string[]): boolean {
        return patterns.some(p => {
            const cleanP = p.replace('/**', '').replace('/*', '');
            if (file === cleanP) return true;
            if (cleanP.endsWith('/')) return file.startsWith(cleanP);
            return file.startsWith(cleanP + '/');
        });
    }
}
