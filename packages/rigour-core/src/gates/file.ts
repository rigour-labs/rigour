import { Gate, GateContext } from './base.js';
import { Failure } from '../types/index.js';
import { FileScanner } from '../utils/scanner.js';

export interface FileGateConfig {
    maxLines: number;
}

export class FileGate extends Gate {
    constructor(private config: FileGateConfig) {
        super('file-size', 'File Size Limit');
    }

    async run(context: GateContext): Promise<Failure[]> {
        const files = await FileScanner.findFiles({
            cwd: context.cwd,
            ignore: context.ignore,
            patterns: context.patterns
        });
        const contents = await FileScanner.readFiles(context.cwd, files);

        const violations: string[] = [];
        for (const [file, content] of contents) {
            const lines = content.split('\n').length;
            if (lines > this.config.maxLines) {
                violations.push(`${file} (${lines} lines)`);
            }
        }

        if (violations.length > 0) {
            return [
                this.createFailure(
                    `The following files exceed the maximum limit of ${this.config.maxLines} lines:`,
                    violations,
                    'Break these files into smaller, more modular components to improve maintainability (SOLID - Single Responsibility Principle).'
                ),
            ];
        }

        return [];
    }
}
