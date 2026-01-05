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
        const patterns = [];
        if (this.config.forbidTodos) patterns.push(/TODO/i);
        if (this.config.forbidFixme) patterns.push(/FIXME/i);

        if (patterns.length === 0) return [];

        const files = await FileScanner.findFiles({
            cwd: context.cwd,
            ignore: context.ignore,
            patterns: context.patterns
        });
        const contents = await FileScanner.readFiles(context.cwd, files);

        const violations: string[] = [];
        for (const [file, content] of contents) {
            for (const pattern of patterns) {
                if (pattern.test(content)) {
                    violations.push(file);
                    break;
                }
            }
        }

        if (violations.length > 0) {
            return [
                this.createFailure(
                    'Forbidden placeholders found in the following files:',
                    violations,
                    'Remove all TODO and FIXME comments. Use the "Done is Done" mentality—address the root cause or create a tracked issue.'
                ),
            ];
        }

        return [];
    }
}
