import { Gate, GateContext } from './base.js';
import { Failure } from '../types/index.js';
import { FileScanner } from '../utils/scanner.js';
import path from 'path';

export interface ContentGateConfig {
    forbidTodos: boolean;
    forbidFixme: boolean;
}

export class ContentGate extends Gate {
    constructor(private config: ContentGateConfig) {
        super('content-check', 'Forbidden Content');
    }

    async run(context: GateContext): Promise<Failure[]> {
        const markers: string[] = [];
        if (this.config.forbidTodos) markers.push('TODO');
        if (this.config.forbidFixme) markers.push('FIXME');

        if (markers.length === 0) return [];

        const files = await FileScanner.findFiles({
            cwd: context.cwd,
            ignore: context.ignore,
            patterns: context.patterns
        });
        const contents = await FileScanner.readFiles(context.cwd, files);

        const failures: Failure[] = [];
        for (const [file, content] of contents) {
            if (!this.shouldScanFile(file)) continue;
            if (this.shouldSkipFile(file)) continue;
            const lines = content.split('\n');
            lines.forEach((line, index) => {
                const commentText = this.extractCommentText(line);
                if (!commentText) return;
                const normalizedComment = this.normalizeCommentText(commentText);
                for (const marker of markers) {
                    if (this.hasForbiddenMarker(normalizedComment, marker)) {
                        failures.push(this.createFailure(
                            `Forbidden placeholder '${marker}' found`,
                            [file],
                            'Remove forbidden comments. address the root cause or create a tracked issue.',
                            undefined,
                            index + 1,
                            index + 1,
                            'info'
                        ));
                    }
                }
            });
        }

        return failures;
    }

    private shouldScanFile(file: string): boolean {
        const ext = path.extname(file).toLowerCase();
        return new Set([
            '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
            '.py', '.go', '.rb', '.java', '.kt', '.cs',
            '.rs', '.php', '.swift', '.scala', '.sh', '.bash',
            '.yml', '.yaml', '.json'
        ]).has(ext);
    }

    private shouldSkipFile(file: string): boolean {
        const normalized = file.replace(/\\/g, '/');
        return (
            normalized.includes('/examples/') ||
            normalized.includes('/__tests__/') ||
            /\.test\.[^.]+$/i.test(normalized) ||
            /\.spec\.[^.]+$/i.test(normalized)
        );
    }

    private extractCommentText(line: string): string | null {
        const trimmed = line.trim();
        if (!trimmed) return null;

        // Whole-line comments across common languages.
        if (
            trimmed.startsWith('//') ||
            trimmed.startsWith('#') ||
            trimmed.startsWith('/*') ||
            trimmed.startsWith('*') ||
            trimmed.startsWith('<!--')
        ) {
            return trimmed;
        }

        // Inline comments (JS/TS/Go style)
        const slashIdx = line.indexOf('//');
        if (slashIdx >= 0) return line.slice(slashIdx);

        // Inline Python/Ruby shell-style comments
        const hashIdx = line.indexOf('#');
        if (hashIdx >= 0) return line.slice(hashIdx);

        return null;
    }

    private normalizeCommentText(commentText: string): string {
        return commentText
            .trim()
            .replace(/^(?:\/\/+|#+|\/\*+|\*+|<!--+)\s*/, '')
            .trim();
    }

    private hasForbiddenMarker(commentText: string, marker: string): boolean {
        // Treat placeholder markers only when used as actionable prefixes,
        // e.g. "TODO: ...", not as explanatory references like "count TODO markers".
        const placeholderPrefix = new RegExp(`^${marker}\\b(?:\\s*[:\\-]|\\s|$)`, 'i');
        return placeholderPrefix.test(commentText);
    }
}
