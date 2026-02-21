/**
 * AST Fact Extractor — Step 1 of the three-step pipeline.
 * Extracts structured facts from code files using tree-sitter AST.
 * These facts ground the LLM analysis and prevent hallucination.
 */
import fs from 'fs-extra';
import path from 'path';
import { globby } from 'globby';

/**
 * Facts extracted from a single file.
 */
export interface FileFacts {
    path: string;
    language: string;
    lineCount: number;
    classes: ClassFact[];
    functions: FunctionFact[];
    imports: string[];
    exports: string[];
    errorHandling: ErrorHandlingFact[];
    testAssertions: number;
    hasTests: boolean;
}

export interface ClassFact {
    name: string;
    lineStart: number;
    lineEnd: number;
    methodCount: number;
    methods: string[];
    publicMethods: string[];
    lineCount: number;
    dependencies: string[]; // imported/injected deps
}

export interface FunctionFact {
    name: string;
    lineStart: number;
    lineEnd: number;
    lineCount: number;
    paramCount: number;
    params: string[];
    maxNesting: number;
    hasReturn: boolean;
    isAsync: boolean;
    isExported: boolean;
}

export interface ErrorHandlingFact {
    type: 'try-catch' | 'catch-only' | 'if-error' | 'promise-catch' | 'error-callback';
    lineStart: number;
    isEmpty: boolean; // empty catch block
    strategy: string; // 'log', 'throw', 'ignore', 'return', 'custom'
}

/**
 * Lightweight regex-based fact extraction.
 * Works across languages without tree-sitter grammar loading.
 * Fast enough for the deep analysis pipeline.
 */
export async function extractFacts(cwd: string, ignore?: string[]): Promise<FileFacts[]> {
    const patterns = ['**/*.{ts,js,tsx,jsx,py,go,rs,cs,java,rb,kt}'];
    const ignorePatterns = [
        ...(ignore || []),
        '**/node_modules/**', '**/dist/**', '**/build/**',
        '**/.git/**', '**/vendor/**', '**/__pycache__/**',
        '**/*.min.js', '**/*.bundle.js',
    ];

    const files = await globby(patterns, { cwd, ignore: ignorePatterns, followSymbolicLinks: false });
    const allFacts: FileFacts[] = [];

    for (const file of files) {
        try {
            const content = await fs.readFile(path.join(cwd, file), 'utf-8');
            const facts = extractFileFacts(file, content);
            if (facts) allFacts.push(facts);
        } catch {
            // Skip unreadable files
        }
    }

    return allFacts;
}

/**
 * Extract facts from a single file's content.
 */
function extractFileFacts(filePath: string, content: string): FileFacts | null {
    const lines = content.split('\n');
    if (lines.length < 3) return null; // Skip trivial files

    const language = detectLanguage(filePath);
    const facts: FileFacts = {
        path: filePath,
        language,
        lineCount: lines.length,
        classes: extractClasses(content, language),
        functions: extractFunctions(content, language),
        imports: extractImports(content, language),
        exports: extractExports(content, language),
        errorHandling: extractErrorHandling(content, language),
        testAssertions: countAssertions(content),
        hasTests: isTestFile(filePath, content),
    };

    return facts;
}

function detectLanguage(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const langMap: Record<string, string> = {
        '.ts': 'typescript', '.tsx': 'typescript',
        '.js': 'javascript', '.jsx': 'javascript',
        '.py': 'python',
        '.go': 'go',
        '.rs': 'rust',
        '.cs': 'csharp',
        '.java': 'java',
        '.rb': 'ruby',
        '.kt': 'kotlin',
    };
    return langMap[ext] || 'unknown';
}

function extractClasses(content: string, lang: string): ClassFact[] {
    const classes: ClassFact[] = [];
    const lines = content.split('\n');

    // Class pattern: works for TS/JS/Java/C#/Python
    const classPattern = lang === 'python'
        ? /^\s*class\s+(\w+)/
        : /(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/;

    for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(classPattern);
        if (!match) continue;

        const name = match[1];
        const lineStart = i + 1;

        // Find class end by brace matching (or indentation for Python)
        let lineEnd = lineStart;
        if (lang === 'python') {
            const baseIndent = lines[i].search(/\S/);
            for (let j = i + 1; j < lines.length; j++) {
                const indent = lines[j].search(/\S/);
                if (indent >= 0 && indent <= baseIndent && lines[j].trim().length > 0) break;
                lineEnd = j + 1;
            }
        } else {
            let braces = 0;
            let started = false;
            for (let j = i; j < lines.length; j++) {
                for (const char of lines[j]) {
                    if (char === '{') { braces++; started = true; }
                    if (char === '}') braces--;
                }
                if (started && braces <= 0) { lineEnd = j + 1; break; }
            }
        }

        // Extract methods within the class
        const classContent = lines.slice(i, lineEnd).join('\n');
        const methodPattern = lang === 'python'
            ? /^\s+def\s+(\w+)/gm
            : /(?:public|private|protected|static|async|get|set)?\s*(?:async\s+)?(\w+)\s*\(/gm;
        const methods: string[] = [];
        const publicMethods: string[] = [];
        let methodMatch;
        while ((methodMatch = methodPattern.exec(classContent)) !== null) {
            const methodName = methodMatch[1];
            if (methodName === name || methodName === 'constructor') continue; // Skip constructor
            methods.push(methodName);
            if (!methodMatch[0].includes('private') && !methodMatch[0].includes('protected')) {
                if (lang !== 'python' || !methodName.startsWith('_')) {
                    publicMethods.push(methodName);
                }
            }
        }

        // Extract dependencies (constructor params, imports used)
        const depPattern = /(?:private|readonly|public)\s+(\w+):\s*(\w+)/g;
        const deps: string[] = [];
        let depMatch;
        while ((depMatch = depPattern.exec(classContent)) !== null) {
            deps.push(depMatch[2]);
        }

        classes.push({
            name,
            lineStart,
            lineEnd,
            methodCount: methods.length,
            methods,
            publicMethods,
            lineCount: lineEnd - lineStart + 1,
            dependencies: deps,
        });
    }

    return classes;
}

function extractFunctions(content: string, lang: string): FunctionFact[] {
    const functions: FunctionFact[] = [];
    const lines = content.split('\n');

    const patterns: RegExp[] = lang === 'python'
        ? [/^(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)/]
        : [
            /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/,
            /(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s+)?\([^)]*\)\s*(?::\s*\w+(?:<[^>]+>)?)?\s*=>/,
            /(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s+)?function/,
        ];

    for (let i = 0; i < lines.length; i++) {
        for (const pattern of patterns) {
            const match = lines[i].match(pattern);
            if (!match) continue;

            const name = match[1];
            if (!name || name === 'if' || name === 'for' || name === 'while') continue;

            const lineStart = i + 1;
            let lineEnd = lineStart;

            // Find function end
            if (lang === 'python') {
                const baseIndent = lines[i].search(/\S/);
                for (let j = i + 1; j < lines.length; j++) {
                    const indent = lines[j].search(/\S/);
                    if (indent >= 0 && indent <= baseIndent && lines[j].trim().length > 0) break;
                    lineEnd = j + 1;
                }
            } else {
                let braces = 0;
                let started = false;
                for (let j = i; j < Math.min(lines.length, i + 500); j++) {
                    for (const char of lines[j]) {
                        if (char === '{') { braces++; started = true; }
                        if (char === '}') braces--;
                    }
                    if (started && braces <= 0) { lineEnd = j + 1; break; }
                    // Arrow functions without braces
                    if (!started && lines[j].includes('=>') && !lines[j].includes('{')) {
                        lineEnd = j + 1; started = true; break;
                    }
                }
            }

            // Extract params
            const paramStr = match[2] || '';
            const params = paramStr.split(',').map(p => p.trim()).filter(p => p.length > 0);

            // Nesting depth
            const funcContent = lines.slice(i, lineEnd).join('\n');
            const maxNesting = calculateMaxNesting(funcContent, lang);

            functions.push({
                name,
                lineStart,
                lineEnd,
                lineCount: lineEnd - lineStart + 1,
                paramCount: params.length,
                params,
                maxNesting,
                hasReturn: funcContent.includes('return ') || funcContent.includes('return;'),
                isAsync: lines[i].includes('async'),
                isExported: lines[i].includes('export'),
            });
            break; // One match per line
        }
    }

    return functions;
}

function extractImports(content: string, lang: string): string[] {
    const imports: string[] = [];

    if (lang === 'python') {
        const pattern = /^(?:from\s+(\S+)\s+)?import\s+(.+)$/gm;
        let match;
        while ((match = pattern.exec(content)) !== null) {
            imports.push(match[1] || match[2].trim());
        }
    } else {
        const pattern = /import\s+.+?from\s+['"](.*?)['"]/g;
        let match;
        while ((match = pattern.exec(content)) !== null) {
            imports.push(match[1]);
        }
        const reqPattern = /require\s*\(\s*['"](.*?)['"]\s*\)/g;
        while ((match = reqPattern.exec(content)) !== null) {
            imports.push(match[1]);
        }
    }

    return imports;
}

function extractExports(content: string, lang: string): string[] {
    const exports: string[] = [];

    if (lang === 'typescript' || lang === 'javascript') {
        const pattern = /export\s+(?:default\s+)?(?:class|function|const|let|var|interface|type|enum)\s+(\w+)/g;
        let match;
        while ((match = pattern.exec(content)) !== null) {
            exports.push(match[1]);
        }
    }

    return exports;
}

function extractErrorHandling(content: string, lang: string): ErrorHandlingFact[] {
    const handlers: ErrorHandlingFact[] = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // try-catch blocks
        if (line.match(/\btry\s*{/) || (lang === 'python' && line.match(/^\s*try\s*:/))) {
            // Look for the catch/except
            for (let j = i + 1; j < Math.min(lines.length, i + 50); j++) {
                const catchMatch = lines[j].match(/\bcatch\s*\(/) || (lang === 'python' && lines[j].match(/^\s*except/));
                if (catchMatch) {
                    // Check if catch body is empty
                    const catchBody = lines.slice(j + 1, Math.min(lines.length, j + 5)).join('\n');
                    const isEmpty = !catchBody.trim() || catchBody.match(/^\s*}\s*$/) !== null;

                    let strategy = 'custom';
                    if (isEmpty || catchBody.match(/^\s*\/\//)) strategy = 'ignore';
                    else if (catchBody.includes('console.log') || catchBody.includes('console.error') || catchBody.includes('print(')) strategy = 'log';
                    else if (catchBody.includes('throw')) strategy = 'throw';
                    else if (catchBody.includes('return')) strategy = 'return';

                    handlers.push({
                        type: 'try-catch',
                        lineStart: i + 1,
                        isEmpty: strategy === 'ignore',
                        strategy,
                    });
                    break;
                }
            }
        }

        // .catch() handlers
        if (line.match(/\.catch\s*\(/)) {
            const nextContent = lines.slice(i, Math.min(lines.length, i + 5)).join('\n');
            const isEmpty = nextContent.match(/\.catch\s*\(\s*\(\s*\)\s*=>\s*{?\s*}?\s*\)/) !== null;
            handlers.push({
                type: 'promise-catch',
                lineStart: i + 1,
                isEmpty,
                strategy: isEmpty ? 'ignore' : 'custom',
            });
        }
    }

    return handlers;
}

function calculateMaxNesting(content: string, lang: string): number {
    let maxNesting = 0;
    let current = 0;

    if (lang === 'python') {
        const lines = content.split('\n');
        for (const line of lines) {
            const indent = line.search(/\S/);
            if (indent >= 0) {
                const level = Math.floor(indent / 4);
                maxNesting = Math.max(maxNesting, level);
            }
        }
    } else {
        for (const char of content) {
            if (char === '{') { current++; maxNesting = Math.max(maxNesting, current); }
            if (char === '}') current--;
        }
    }

    return maxNesting;
}

function countAssertions(content: string): number {
    const patterns = [
        /\bexpect\s*\(/g,
        /\bassert\w*\s*[.(]/g,
        /\bshould\./g,
        /\.to(Be|Equal|Have|Throw|Match|Include|Contain)/g,
    ];
    let count = 0;
    for (const p of patterns) {
        const matches = content.match(p);
        if (matches) count += matches.length;
    }
    return count;
}

function isTestFile(filePath: string, content: string): boolean {
    if (filePath.match(/\.(test|spec|_test)\./)) return true;
    if (filePath.includes('__tests__') || filePath.includes('test/') || filePath.includes('tests/')) return true;
    if (content.includes('describe(') || content.includes('it(') || content.includes('test(')) return true;
    if (content.includes('def test_') || content.includes('@pytest')) return true;
    return false;
}

/**
 * Serialize facts into a compact string for LLM prompts.
 * Keeps only the most relevant information within token budget.
 */
export function factsToPromptString(facts: FileFacts[], maxChars = 4000): string {
    const parts: string[] = [];

    for (const f of facts) {
        const filePart: string[] = [`FILE: ${f.path} (${f.language}, ${f.lineCount} lines)`];

        for (const cls of f.classes) {
            filePart.push(
                `  CLASS ${cls.name} (${cls.lineCount} lines, ${cls.methodCount} methods: ${cls.methods.join(', ')})`
            );
            if (cls.dependencies.length > 0) {
                filePart.push(`    deps: ${cls.dependencies.join(', ')}`);
            }
        }

        for (const fn of f.functions) {
            if (fn.lineCount < 10) continue; // Skip tiny functions
            const flags = [
                fn.isAsync ? 'async' : '',
                fn.isExported ? 'exported' : '',
                fn.maxNesting > 3 ? `nesting:${fn.maxNesting}` : '',
            ].filter(Boolean).join(', ');
            filePart.push(
                `  FN ${fn.name}(${fn.params.join(', ')}) [${fn.lineCount} lines${flags ? ', ' + flags : ''}]`
            );
        }

        if (f.errorHandling.length > 0) {
            const strategies = f.errorHandling.map(e => e.strategy);
            const unique = [...new Set(strategies)];
            filePart.push(`  ERROR_HANDLING: ${unique.join(', ')} (${f.errorHandling.filter(e => e.isEmpty).length} empty catches)`);
        }

        if (f.hasTests) {
            filePart.push(`  TESTS: ${f.testAssertions} assertions`);
        }

        parts.push(filePart.join('\n'));

        // Rough token budget check
        const totalLength = parts.join('\n\n').length;
        if (totalLength > maxChars) break;
    }

    return parts.join('\n\n');
}
