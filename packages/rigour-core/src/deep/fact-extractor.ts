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
    // Go/Rust-specific
    structs?: StructFact[];
    interfaces?: InterfaceFact[];
    goroutines?: number;
    channels?: number;
    defers?: number;
    mutexes?: number;
    // General metrics
    cyclomaticComplexity?: number;
    commentRatio?: number;
    magicNumbers?: number;
    todoCount?: number;
}

export interface StructFact {
    name: string;
    lineStart: number;
    lineEnd: number;
    fieldCount: number;
    methodCount: number;
    methods: string[];
    lineCount: number;
    embeds: string[];  // embedded types
}

export interface InterfaceFact {
    name: string;
    lineStart: number;
    methodCount: number;
    methods: string[];
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

    // Go/Rust-specific extraction
    if (language === 'go') {
        facts.structs = extractGoStructs(content);
        facts.interfaces = extractGoInterfaces(content);
        facts.goroutines = (content.match(/\bgo\s+\w+/g) || []).length;
        facts.channels = (content.match(/\bch?an\b|make\s*\(\s*chan\b|<-\s*\w+|\w+\s*<-/g) || []).length;
        facts.defers = (content.match(/\bdefer\b/g) || []).length;
        facts.mutexes = (content.match(/sync\.(?:Mutex|RWMutex|WaitGroup|Once|Pool|Map)|\.Lock\(\)|\.Unlock\(\)|\.RLock\(\)|\.RUnlock\(\)/g) || []).length;
        // Go functions include methods with receivers — augment with receiver info
        facts.functions = extractGoFunctions(content);
    }

    // General quality metrics (all languages)
    facts.commentRatio = countCommentRatio(content, language);
    facts.magicNumbers = countMagicNumbers(content, language);
    facts.todoCount = (content.match(/\b(?:TODO|FIXME|HACK|XXX|WORKAROUND)\b/gi) || []).length;

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

// ── Go-specific extractors ──

function extractGoStructs(content: string): StructFact[] {
    const structs: StructFact[] = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(/^type\s+(\w+)\s+struct\s*\{/);
        if (!match) continue;

        const name = match[1];
        const lineStart = i + 1;
        let lineEnd = lineStart;
        let braces = 0;
        let started = false;
        const fields: string[] = [];
        const embeds: string[] = [];

        for (let j = i; j < lines.length; j++) {
            for (const char of lines[j]) {
                if (char === '{') { braces++; started = true; }
                if (char === '}') braces--;
            }
            // Count fields (lines inside struct with type declarations)
            if (j > i && braces > 0) {
                const fieldLine = lines[j].trim();
                if (fieldLine && !fieldLine.startsWith('//') && !fieldLine.startsWith('{')) {
                    // Embedded type (single word, capitalized)
                    if (fieldLine.match(/^\*?\w+$/)) {
                        embeds.push(fieldLine.replace(/^\*/, ''));
                    } else if (fieldLine.includes(' ')) {
                        fields.push(fieldLine.split(/\s+/)[0]);
                    }
                }
            }
            if (started && braces <= 0) { lineEnd = j + 1; break; }
        }

        // Find methods with this struct as receiver
        const methods: string[] = [];
        const methodPattern = new RegExp(`^func\\s*\\(\\s*\\w+\\s+\\*?${name}\\s*\\)\\s+(\\w+)\\s*\\(`, 'gm');
        let methodMatch;
        while ((methodMatch = methodPattern.exec(content)) !== null) {
            methods.push(methodMatch[1]);
        }

        structs.push({
            name,
            lineStart,
            lineEnd,
            fieldCount: fields.length + embeds.length,
            methodCount: methods.length,
            methods,
            lineCount: lineEnd - lineStart + 1,
            embeds,
        });
    }

    return structs;
}

function extractGoInterfaces(content: string): InterfaceFact[] {
    const interfaces: InterfaceFact[] = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(/^type\s+(\w+)\s+interface\s*\{/);
        if (!match) continue;

        const name = match[1];
        const methods: string[] = [];
        let braces = 0;
        let started = false;

        for (let j = i; j < lines.length; j++) {
            for (const char of lines[j]) {
                if (char === '{') { braces++; started = true; }
                if (char === '}') braces--;
            }
            if (j > i && braces > 0) {
                const methodMatch = lines[j].trim().match(/^(\w+)\s*\(/);
                if (methodMatch) methods.push(methodMatch[1]);
            }
            if (started && braces <= 0) break;
        }

        interfaces.push({
            name,
            lineStart: i + 1,
            methodCount: methods.length,
            methods,
        });
    }

    return interfaces;
}

function extractGoFunctions(content: string): FunctionFact[] {
    const functions: FunctionFact[] = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
        // Match both standalone funcs and receiver methods
        const match = lines[i].match(/^func\s+(?:\(\s*\w+\s+\*?(\w+)\s*\)\s+)?(\w+)\s*\(([^)]*)\)/);
        if (!match) continue;

        const receiver = match[1] || '';
        const name = receiver ? `${receiver}.${match[2]}` : match[2];
        const paramStr = match[3] || '';
        const lineStart = i + 1;
        let lineEnd = lineStart;
        let braces = 0;
        let started = false;

        for (let j = i; j < Math.min(lines.length, i + 500); j++) {
            for (const char of lines[j]) {
                if (char === '{') { braces++; started = true; }
                if (char === '}') braces--;
            }
            if (started && braces <= 0) { lineEnd = j + 1; break; }
        }

        const params = paramStr.split(',').map(p => p.trim()).filter(p => p.length > 0);
        const funcContent = lines.slice(i, lineEnd).join('\n');
        const maxNesting = calculateMaxNesting(funcContent, 'go');
        const hasErrorReturn = funcContent.includes('error') && funcContent.includes('return');

        functions.push({
            name,
            lineStart,
            lineEnd,
            lineCount: lineEnd - lineStart + 1,
            paramCount: params.length,
            params,
            maxNesting,
            hasReturn: funcContent.includes('return ') || funcContent.includes('return\n'),
            isAsync: funcContent.includes('go ') || funcContent.includes('goroutine'),
            isExported: match[2].charAt(0) === match[2].charAt(0).toUpperCase(),
        });
    }

    return functions;
}

// ── General quality metrics ──

function countCommentRatio(content: string, lang: string): number {
    const lines = content.split('\n');
    let commentLines = 0;
    const commentPatterns: RegExp[] = lang === 'python'
        ? [/^\s*#/, /^\s*"""/]
        : [/^\s*\/\//, /^\s*\/\*/, /^\s*\*/];

    for (const line of lines) {
        if (commentPatterns.some(p => p.test(line))) commentLines++;
    }
    return lines.length > 0 ? Math.round((commentLines / lines.length) * 100) : 0;
}

function countMagicNumbers(content: string, lang: string): number {
    // Exclude 0, 1, -1, common HTTP codes, common sizes
    const allowed = new Set(['0', '1', '-1', '2', '100', '200', '201', '204', '301', '302', '400', '401', '403', '404', '500']);
    const matches = content.match(/(?<![.\w])\d{2,}(?![.\w])/g) || [];
    return matches.filter(m => !allowed.has(m)).length;
}

/**
 * Serialize facts into a compact string for LLM prompts.
 * Keeps only the most relevant information within token budget.
 */
export function factsToPromptString(facts: FileFacts[], maxChars = 8000): string {
    const parts: string[] = [];

    for (const f of facts) {
        const filePart: string[] = [`FILE: ${f.path} (${f.language}, ${f.lineCount} lines)`];

        // Quality metrics
        const metrics: string[] = [];
        if (f.commentRatio !== undefined && f.commentRatio < 5 && f.lineCount > 50) metrics.push(`comments:${f.commentRatio}%`);
        if (f.magicNumbers && f.magicNumbers > 3) metrics.push(`magic_numbers:${f.magicNumbers}`);
        if (f.todoCount && f.todoCount > 0) metrics.push(`todos:${f.todoCount}`);
        if (metrics.length > 0) filePart.push(`  METRICS: ${metrics.join(', ')}`);

        // Classes (JS/TS/Python/Java/C#)
        for (const cls of f.classes) {
            filePart.push(
                `  CLASS ${cls.name} (${cls.lineCount} lines, ${cls.methodCount} methods: ${cls.methods.join(', ')})`
            );
            if (cls.dependencies.length > 0) {
                filePart.push(`    deps: ${cls.dependencies.join(', ')}`);
            }
        }

        // Go structs
        if (f.structs) {
            for (const s of f.structs) {
                const embedStr = s.embeds.length > 0 ? `, embeds: ${s.embeds.join(', ')}` : '';
                filePart.push(
                    `  STRUCT ${s.name} (${s.lineCount} lines, ${s.fieldCount} fields, ${s.methodCount} methods: ${s.methods.join(', ')}${embedStr})`
                );
            }
        }

        // Go interfaces
        if (f.interfaces) {
            for (const iface of f.interfaces) {
                filePart.push(
                    `  INTERFACE ${iface.name} (${iface.methodCount} methods: ${iface.methods.join(', ')})`
                );
            }
        }

        // Go concurrency signals
        if (f.language === 'go') {
            const goSignals: string[] = [];
            if (f.goroutines && f.goroutines > 0) goSignals.push(`goroutines:${f.goroutines}`);
            if (f.channels && f.channels > 0) goSignals.push(`channels:${f.channels}`);
            if (f.defers && f.defers > 0) goSignals.push(`defers:${f.defers}`);
            if (f.mutexes && f.mutexes > 0) goSignals.push(`mutexes:${f.mutexes}`);
            if (goSignals.length > 0) filePart.push(`  CONCURRENCY: ${goSignals.join(', ')}`);
        }

        // Functions (all languages)
        for (const fn of f.functions) {
            if (fn.lineCount < 8) continue; // Skip tiny functions
            const flags = [
                fn.isAsync ? 'async' : '',
                fn.isExported ? 'exported' : '',
                fn.maxNesting > 3 ? `nesting:${fn.maxNesting}` : '',
                fn.paramCount > 4 ? `params:${fn.paramCount}` : '',
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

        if (f.imports.length > 0) {
            filePart.push(`  IMPORTS: ${f.imports.length} (${f.imports.slice(0, 8).join(', ')}${f.imports.length > 8 ? '...' : ''})`);
        }

        parts.push(filePart.join('\n'));

        // Rough token budget check
        const totalLength = parts.join('\n\n').length;
        if (totalLength > maxChars) break;
    }

    return parts.join('\n\n');
}
