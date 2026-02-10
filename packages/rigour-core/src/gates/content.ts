import { Gate, GateContext } from './base.js';
import { Failure } from '../types/index.js';
import { FileScanner } from '../utils/scanner.js';

export interface ContentGateConfig {
    forbidTodos: boolean;
    forbidFixme: boolean;
}

export class ContentGate extends Gate {
    constructor(private config: ContentGateConfig) {
        super('content-check', 'Forbidden Content');
    }

    async run(context: GateContext): Promise<Failure[]> {
        const patterns: RegExp[] = [];
        if (this.config.forbidTodos) patterns.push(/TODO/i);
        if (this.config.forbidFixme) patterns.push(/FIXME/i);

        if (patterns.length === 0) return [];

        const files = await FileScanner.findFiles({
            cwd: context.cwd,
            ignore: context.ignore,
            patterns: context.patterns
        });
        const contents = await FileScanner.readFiles(context.cwd, files);

        const failures: Failure[] = [];
        for (const [file, content] of contents) {
            const lines = content.split('\n');
            lines.forEach((line, index) => {
                for (const pattern of patterns) {
                    if (pattern.test(line)) {
                        failures.push(this.createFailure(
                            `Forbidden placeholder '${pattern.source}' found`,
                            [file],
                            'Remove forbidden comments. address the root cause or create a tracked issue.',
                            undefined,
                            index + 1,
                            index + 1
                        ));
                    }
                }
            });
        }

        return failures;
    }
}
