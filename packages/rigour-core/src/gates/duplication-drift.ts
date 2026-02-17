/**
 * Duplication Drift Gate
 *
 * Detects when AI generates near-identical functions across files because
 * it doesn't remember what it already wrote. This is an AI-specific failure
 * mode — humans reuse via copy-paste (same file), AI re-invents (cross-file).
 *
 * Detection strategy:
 * 1. Extract all function bodies (normalized: strip whitespace, comments)
 * 2. Compare function signatures + body hashes across files
 * 3. Flag functions with >80% similarity in different files
 *
 * @since v2.16.0
 */

import { Gate, GateContext } from './base.js';
import { Failure, Provenance } from '../types/index.js';
import { FileScanner } from '../utils/scanner.js';
import { Logger } from '../utils/logger.js';
import crypto from 'crypto';
import path from 'path';

interface FunctionSignature {
    name: string;
    file: string;
    line: number;
    paramCount: number;
    bodyHash: string;
    bodyLength: number;
    normalized: string;
}

export interface DuplicationDriftConfig {
    enabled?: boolean;
    similarity_threshold?: number; // 0-1, default 0.8
    min_body_lines?: number;       // Ignore trivial functions, default 5
}

export class DuplicationDriftGate extends Gate {
    private config: Required<DuplicationDriftConfig>;

    constructor(config: DuplicationDriftConfig = {}) {
        super('duplication-drift', 'AI Duplication Drift Detection');
        this.config = {
            enabled: config.enabled ?? true,
            similarity_threshold: config.similarity_threshold ?? 0.8,
            min_body_lines: config.min_body_lines ?? 5,
        };
    }

    protected get provenance(): Provenance { return 'ai-drift'; }

    async run(context: GateContext): Promise<Failure[]> {
        if (!this.config.enabled) return [];

        const failures: Failure[] = [];
        const functions: FunctionSignature[] = [];

        const files = await FileScanner.findFiles({
            cwd: context.cwd,
            patterns: ['**/*.{ts,js,tsx,jsx,py}'],
            ignore: [...(context.ignore || []), '**/node_modules/**', '**/dist/**', '**/*.test.*', '**/*.spec.*'],
        });

        Logger.info(`Duplication Drift: Scanning ${files.length} files`);

        for (const file of files) {
            try {
                const { readFile } = await import('fs-extra');
                const content = await readFile(path.join(context.cwd, file), 'utf-8');
                const ext = path.extname(file);

                if (['.ts', '.js', '.tsx', '.jsx'].includes(ext)) {
                    this.extractJSFunctions(content, file, functions);
                } else if (ext === '.py') {
                    this.extractPyFunctions(content, file, functions);
                }
            } catch (e) { }
        }

        // Compare all function pairs across different files
        const duplicateGroups = this.findDuplicateGroups(functions);

        for (const group of duplicateGroups) {
            const files = group.map(f => f.file);
            const locations = group.map(f => `${f.file}:${f.line} (${f.name})`).join(', ');

            failures.push(this.createFailure(
                `AI Duplication Drift: Function '${group[0].name}' has ${group.length} near-identical copies across files`,
                [...new Set(files)],
                `Found duplicate implementations at: ${locations}. Extract to a shared module and import.`,
                'Duplication Drift',
                group[0].line,
                undefined,
                'high'
            ));
        }

        return failures;
    }

    private extractJSFunctions(content: string, file: string, functions: FunctionSignature[]) {
        const lines = content.split('\n');

        // Match function declarations, arrow functions, and method definitions
        const patterns = [
            // function name(...) {
            /^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/,
            // const name = (...) => {
            /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|(\w+))\s*=>/,
            // name(...) { — class method
            /^\s+(?:async\s+)?(\w+)\s*\(([^)]*)\)\s*\{/,
        ];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            for (const pattern of patterns) {
                const match = line.match(pattern);
                if (match) {
                    const name = match[1];
                    const params = match[2] || '';
                    const body = this.extractFunctionBody(lines, i);

                    if (body.length >= this.config.min_body_lines) {
                        const normalized = this.normalizeBody(body.join('\n'));
                        functions.push({
                            name,
                            file,
                            line: i + 1,
                            paramCount: params ? params.split(',').length : 0,
                            bodyHash: this.hash(normalized),
                            bodyLength: body.length,
                            normalized,
                        });
                    }
                    break;
                }
            }
        }
    }

    private extractPyFunctions(content: string, file: string, functions: FunctionSignature[]) {
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
            const match = lines[i].match(/^(?:\s*)(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)/);
            if (match) {
                const name = match[1];
                const params = match[2] || '';
                const indent = lines[i].match(/^(\s*)/)?.[1]?.length || 0;

                // Extract body by indentation
                const body: string[] = [];
                for (let j = i + 1; j < lines.length; j++) {
                    const lineIndent = lines[j].match(/^(\s*)/)?.[1]?.length || 0;
                    if (lines[j].trim() === '' || lineIndent > indent) {
                        body.push(lines[j]);
                    } else {
                        break;
                    }
                }

                if (body.length >= this.config.min_body_lines) {
                    const normalized = this.normalizeBody(body.join('\n'));
                    functions.push({
                        name,
                        file,
                        line: i + 1,
                        paramCount: params ? params.split(',').length : 0,
                        bodyHash: this.hash(normalized),
                        bodyLength: body.length,
                        normalized,
                    });
                }
            }
        }
    }

    private extractFunctionBody(lines: string[], startIndex: number): string[] {
        let braceDepth = 0;
        let started = false;
        const body: string[] = [];

        for (let i = startIndex; i < lines.length; i++) {
            const line = lines[i];
            for (const ch of line) {
                if (ch === '{') { braceDepth++; started = true; }
                if (ch === '}') braceDepth--;
            }
            if (started) body.push(line);
            if (started && braceDepth === 0) break;
        }

        return body;
    }

    private normalizeBody(body: string): string {
        return body
            .replace(/\/\/.*/g, '')           // strip single-line comments
            .replace(/\/\*[\s\S]*?\*\//g, '') // strip multi-line comments
            .replace(/#.*/g, '')              // strip Python comments
            .replace(/`[^`]*`/g, '"STR"')    // normalize template literals to placeholder
            .replace(/\basync\s+/g, '')       // normalize async modifier
            .replace(/\s+/g, ' ')            // collapse whitespace
            .replace(/['"]/g, '"')           // normalize single/double quotes (NOT backticks)
            .trim();
    }

    private hash(text: string): string {
        return crypto.createHash('md5').update(text).digest('hex');
    }

    private findDuplicateGroups(functions: FunctionSignature[]): FunctionSignature[][] {
        const groups = new Map<string, FunctionSignature[]>();

        // Group by body hash (exact duplicates across files)
        for (const fn of functions) {
            const existing = groups.get(fn.bodyHash) || [];
            existing.push(fn);
            groups.set(fn.bodyHash, existing);
        }

        // Filter: only groups with functions from DIFFERENT files, 2+ members
        const duplicates: FunctionSignature[][] = [];
        for (const group of groups.values()) {
            if (group.length < 2) continue;
            const uniqueFiles = new Set(group.map(f => f.file));
            if (uniqueFiles.size >= 2) {
                duplicates.push(group);
            }
        }

        return duplicates;
    }
}
