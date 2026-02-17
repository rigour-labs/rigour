/**
 * Pattern Indexer
 * 
 * Scans the codebase and extracts patterns using AST parsing.
 * This is the core engine of the Pattern Index system.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';
import { globby } from 'globby';
import ts from 'typescript';
import type {
    PatternEntry,
    PatternIndex,
    PatternIndexConfig,
    PatternIndexStats,
    PatternType,
    IndexedFile
} from './types.js';
import { generateEmbedding } from './embeddings.js';

/** Default configuration for the indexer */
const DEFAULT_CONFIG: PatternIndexConfig = {
    include: ['src/**/*', 'lib/**/*', 'app/**/*', 'components/**/*', 'utils/**/*', 'hooks/**/*', '**/tests/**/*', '**/test/**/*'],
    exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/build/**',
        '**/.git/**',
        '**/coverage/**',
        '**/venv/**',
        '**/.venv/**',
        '**/__pycache__/**',
        '**/site-packages/**',
        '**/.pytest_cache/**',
        '**/target/**', // Rust build dir
        '**/bin/**',
        '**/.gradle/**',
        '**/.mvn/**'
    ],
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.cpp', '.h', '.rb', '.php', '.cs', '.kt'],
    indexTests: false,
    indexNodeModules: false,
    minNameLength: 2,
    categories: {},
    useEmbeddings: false
};

/** Current index format version */
const INDEX_VERSION = '1.0.0';

/**
 * Pattern Indexer class.
 * Responsible for scanning and indexing code patterns.
 */
export class PatternIndexer {
    private config: PatternIndexConfig;
    private rootDir: string;

    constructor(rootDir: string, config: Partial<PatternIndexConfig> = {}) {
        this.rootDir = rootDir;
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    async buildIndex(): Promise<PatternIndex> {
        const startTime = Date.now();

        // Find all files to index
        const files = await this.findFiles();

        // Process files in parallel batches (concurrency: 10)
        const BATCH_SIZE = 10;
        const patterns: PatternEntry[] = [];
        const indexedFiles: IndexedFile[] = [];

        for (let i = 0; i < files.length; i += BATCH_SIZE) {
            const batch = files.slice(i, i + BATCH_SIZE);
            const results = await Promise.all(batch.map(async (file) => {
                try {
                    const relativePath = path.relative(this.rootDir, file);
                    const content = await fs.readFile(file, 'utf-8');
                    const fileHash = this.hashContent(content);

                    const filePatterns = await this.extractPatterns(file, content);

                    return {
                        patterns: filePatterns,
                        fileInfo: {
                            path: relativePath,
                            hash: fileHash,
                            patternCount: filePatterns.length,
                            indexedAt: new Date().toISOString()
                        }
                    };
                } catch (error) {
                    console.error(`Error indexing ${file}:`, error);
                    return null;
                }
            }));

            for (const result of results) {
                if (result) {
                    patterns.push(...result.patterns);
                    indexedFiles.push(result.fileInfo);
                }
            }
        }

        // Generate embeddings in parallel batches if enabled
        if (this.config.useEmbeddings && patterns.length > 0) {
            // Use stderr to avoid contaminating JSON output on stdout
            process.stderr.write(`Generating embeddings for ${patterns.length} patterns...\n`);
            for (let i = 0; i < patterns.length; i += BATCH_SIZE) {
                const batch = patterns.slice(i, i + BATCH_SIZE);
                await Promise.all(batch.map(async (pattern) => {
                    pattern.embedding = await generateEmbedding(`${pattern.name} ${pattern.type} ${pattern.description}`);
                }));
            }
        }

        const endTime = Date.now();
        const stats = this.calculateStats(patterns, indexedFiles, endTime - startTime);

        const index: PatternIndex = {
            version: INDEX_VERSION,
            lastUpdated: new Date().toISOString(),
            rootDir: this.rootDir,
            patterns,
            stats,
            files: indexedFiles
        };

        return index;
    }

    /**
     * Incremental index update - only reindex changed files.
     */
    async updateIndex(existingIndex: PatternIndex): Promise<PatternIndex> {
        const startTime = Date.now();
        const files = await this.findFiles();

        const updatedPatterns: PatternEntry[] = [];
        const updatedFiles: IndexedFile[] = [];

        // Create a map of existing file hashes
        const existingFileMap = new Map(
            existingIndex.files.map(f => [f.path, f])
        );

        // Process files in parallel batches (concurrency: 10)
        const BATCH_SIZE = 10;
        for (let i = 0; i < files.length; i += BATCH_SIZE) {
            const batch = files.slice(i, i + BATCH_SIZE);
            const results = await Promise.all(batch.map(async (file) => {
                const relativePath = path.relative(this.rootDir, file);
                const content = await fs.readFile(file, 'utf-8');
                const fileHash = this.hashContent(content);

                const existingFile = existingFileMap.get(relativePath);

                if (existingFile && existingFile.hash === fileHash) {
                    // File unchanged, keep existing patterns
                    const existingPatterns = existingIndex.patterns.filter(
                        p => p.file === relativePath
                    );
                    return { patterns: existingPatterns, fileInfo: existingFile };
                } else {
                    // File changed or new, reindex
                    const filePatterns = await this.extractPatterns(file, content);
                    return {
                        patterns: filePatterns,
                        fileInfo: {
                            path: relativePath,
                            hash: fileHash,
                            patternCount: filePatterns.length,
                            indexedAt: new Date().toISOString()
                        }
                    };
                }
            }));

            for (const result of results) {
                updatedPatterns.push(...result.patterns);
                updatedFiles.push(result.fileInfo);
            }
        }

        // Update embeddings for new/changed patterns if enabled
        if (this.config.useEmbeddings && updatedPatterns.length > 0) {
            for (let i = 0; i < updatedPatterns.length; i += BATCH_SIZE) {
                const batch = updatedPatterns.slice(i, i + BATCH_SIZE);
                await Promise.all(batch.map(async (pattern) => {
                    if (!pattern.embedding) {
                        pattern.embedding = await generateEmbedding(`${pattern.name} ${pattern.type} ${pattern.description}`);
                    }
                }));
            }
        }

        const endTime = Date.now();
        const stats = this.calculateStats(updatedPatterns, updatedFiles, endTime - startTime);

        return {
            version: INDEX_VERSION,
            lastUpdated: new Date().toISOString(),
            rootDir: this.rootDir,
            patterns: updatedPatterns,
            stats,
            files: updatedFiles
        };
    }

    /**
     * Find all files to index based on configuration.
     */
    private async findFiles(): Promise<string[]> {
        const patterns = this.config.include.map(p =>
            this.config.extensions.map(ext =>
                p.endsWith('*') ? `${p}${ext}` : p
            )
        ).flat();

        let exclude = [...this.config.exclude];

        if (!this.config.indexTests) {
            exclude.push('**/*.test.*', '**/*.spec.*', '**/__tests__/**');
        }

        const files = await globby(patterns, {
            cwd: this.rootDir,
            absolute: true,
            ignore: exclude,
            gitignore: true
        });

        return files;
    }

    /**
     * Extract patterns from a single file using TypeScript AST.
     */
    private async extractPatterns(filePath: string, content: string): Promise<PatternEntry[]> {
        const ext = path.extname(filePath).toLowerCase();

        // Specific high-fidelity extractors
        if (ext === '.py') return this.extractPythonPatterns(filePath, content);
        if (ext === '.go') return this.extractGoPatterns(filePath, content);
        if (ext === '.rs') return this.extractRustPatterns(filePath, content);
        if (ext === '.java' || ext === '.kt' || ext === '.cs') return this.extractJVMStylePatterns(filePath, content);

        // Fallback for TS/JS or other C-style languages
        const patterns: PatternEntry[] = [];
        const relativePath = path.relative(this.rootDir, filePath);

        // For TS/JS, use AST
        if (['.ts', '.tsx', '.js', '.jsx'].includes(ext)) {
            const sourceFile = ts.createSourceFile(
                filePath,
                content,
                ts.ScriptTarget.Latest,
                true,
                this.getScriptKind(filePath)
            );

            const visit = (node: ts.Node) => {
                const pattern = this.nodeToPattern(node, sourceFile, relativePath, content);
                if (pattern) patterns.push(pattern);
                ts.forEachChild(node, visit);
            };
            visit(sourceFile);
            return patterns;
        }

        // Generic C-style fallback (C++, PHP, etc.)
        return this.extractGenericCPatterns(filePath, content);
    }

    /**
     * Extract patterns from Go files.
     */
    private extractGoPatterns(filePath: string, content: string): PatternEntry[] {
        const patterns: PatternEntry[] = [];
        const relativePath = path.relative(this.rootDir, filePath);
        const lines = content.split('\n');

        const funcRegex = /^func\s+(?:\([^)]*\)\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*([^\{]*)\s*\{/;
        const typeRegex = /^type\s+([A-Za-z_][A-Za-z0-9_]*)\s+(struct|interface)/;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            // Functions
            const funcMatch = line.match(funcRegex);
            if (funcMatch) {
                const name = funcMatch[1];
                patterns.push(this.createPatternEntry({
                    type: 'function',
                    name,
                    file: relativePath,
                    line: i + 1,
                    endLine: this.findBraceBlockEnd(lines, i),
                    signature: `func ${name}(${funcMatch[2]}) ${funcMatch[3].trim()}`,
                    description: this.getCOMLineComments(lines, i - 1),
                    keywords: this.extractKeywords(name),
                    content: this.getBraceBlockContent(lines, i),
                    exported: /^[A-Z]/.test(name)
                }));
            }

            // Types/Structs
            const typeMatch = line.match(typeRegex);
            if (typeMatch) {
                const name = typeMatch[1];
                patterns.push(this.createPatternEntry({
                    type: typeMatch[2] as any,
                    name,
                    file: relativePath,
                    line: i + 1,
                    endLine: this.findBraceBlockEnd(lines, i),
                    signature: `type ${name} ${typeMatch[2]}`,
                    description: this.getCOMLineComments(lines, i - 1),
                    keywords: this.extractKeywords(name),
                    content: this.getBraceBlockContent(lines, i),
                    exported: /^[A-Z]/.test(name)
                }));
            }
        }
        return patterns;
    }

    /**
     * Extract patterns from Rust files.
     */
    private extractRustPatterns(filePath: string, content: string): PatternEntry[] {
        const patterns: PatternEntry[] = [];
        const relativePath = path.relative(this.rootDir, filePath);
        const lines = content.split('\n');

        const fnRegex = /^(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*[<(][^)]*[>)]\s*(?:->\s*[^\{]+)?\s*\{/;
        const typeRegex = /^(?:pub\s+)?(struct|enum|trait)\s+([A-Za-z_][A-Za-z0-9_]*)/;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            const fnMatch = line.match(fnRegex);
            if (fnMatch) {
                const name = fnMatch[1];
                patterns.push(this.createPatternEntry({
                    type: 'function',
                    name,
                    file: relativePath,
                    line: i + 1,
                    endLine: this.findBraceBlockEnd(lines, i),
                    signature: line.split('{')[0].trim(),
                    description: this.getCOMLineComments(lines, i - 1),
                    keywords: this.extractKeywords(name),
                    content: this.getBraceBlockContent(lines, i),
                    exported: line.startsWith('pub')
                }));
            }
        }
        return patterns;
    }

    /**
     * Generic extraction for C-style languages (Java, C++, PHP, etc.)
     */
    private extractJVMStylePatterns(filePath: string, content: string): PatternEntry[] {
        const patterns: PatternEntry[] = [];
        const relativePath = path.relative(this.rootDir, filePath);
        const lines = content.split('\n');

        // Simplified for classes and methods
        const classRegex = /^(?:public|private|protected|internal)?\s*(?:static\s+)?(?:final\s+)?(?:class|interface|enum)\s+([A-Za-z0-9_]+)/;
        const methodRegex = /^(?:public|private|protected|internal)\s+(?:static\s+)?(?:async\s+)?(?:[A-Za-z0-9_<>\[\]]+\s+)([A-Za-z0-9_]+)\s*\(/;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();

            const classMatch = line.match(classRegex);
            if (classMatch) {
                patterns.push(this.createPatternEntry({
                    type: 'class',
                    name: classMatch[1],
                    file: relativePath,
                    line: i + 1,
                    endLine: this.findBraceBlockEnd(lines, i),
                    signature: line,
                    description: this.getJavaDoc(lines, i - 1),
                    keywords: this.extractKeywords(classMatch[1]),
                    content: this.getBraceBlockContent(lines, i),
                    exported: line.includes('public')
                }));
            }
        }
        return patterns;
    }

    private extractGenericCPatterns(filePath: string, content: string): PatternEntry[] {
        // Fallback for everything else
        return [];
    }

    private getCOMLineComments(lines: string[], startIndex: number): string {
        let comments = [];
        for (let i = startIndex; i >= 0; i--) {
            const line = lines[i].trim();
            if (line.startsWith('//')) comments.unshift(line.replace('//', '').trim());
            else break;
        }
        return comments.join(' ');
    }

    private getJavaDoc(lines: string[], startIndex: number): string {
        let comments = [];
        let inDoc = false;
        for (let i = startIndex; i >= 0; i--) {
            const line = lines[i].trim();
            if (line.endsWith('*/')) inDoc = true;
            if (inDoc) comments.unshift(line.replace('/**', '').replace('*/', '').replace('*', '').trim());
            if (line.startsWith('/**')) break;
        }
        return comments.join(' ');
    }

    private findBraceBlockEnd(lines: string[], startIndex: number): number {
        let braceCount = 0;
        let started = false;
        for (let i = startIndex; i < lines.length; i++) {
            const line = lines[i];
            if (line.includes('{')) {
                braceCount += (line.match(/\{/g) || []).length;
                started = true;
            }
            if (line.includes('}')) {
                braceCount -= (line.match(/\}/g) || []).length;
            }
            if (started && braceCount === 0) return i + 1;
        }
        return lines.length;
    }

    private getBraceBlockContent(lines: string[], startIndex: number): string {
        const end = this.findBraceBlockEnd(lines, startIndex);
        return lines.slice(startIndex, end).join('\n');
    }

    /**
     * Extract patterns from Python files using regex.
     */
    private extractPythonPatterns(filePath: string, content: string): PatternEntry[] {
        const patterns: PatternEntry[] = [];
        const relativePath = path.relative(this.rootDir, filePath);
        const lines = content.split('\n');

        // Regex for Class definitions
        const classRegex = /^class\s+([A-Za-z_][A-Za-z0-9_]*)\s*(\([^)]*\))?\s*:/;
        // Regex for Function definitions (including async)
        const funcRegex = /^(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*(?:->\s*[^:]+)?\s*:/;
        // Regex for Constants (Top-level UPPER_CASE variables)
        const constRegex = /^([A-Z][A-Z0-9_]*)\s*=\s*(.+)$/;

        for (let i = 0; i < lines.length; i++) {
            const lineContent = lines[i].trim();
            const originalLine = lines[i];
            const lineNum = i + 1;

            // Classes
            const classMatch = originalLine.match(classRegex);
            if (classMatch) {
                const name = classMatch[1];
                if (name.length >= this.config.minNameLength) {
                    patterns.push(this.createPatternEntry({
                        type: this.detectPythonClassType(name),
                        name,
                        file: relativePath,
                        line: lineNum,
                        endLine: this.findPythonBlockEnd(lines, i),
                        signature: `class ${name}${classMatch[2] || ''}`,
                        description: this.getPythonDocstring(lines, i + 1),
                        keywords: this.extractKeywords(name),
                        content: this.getPythonBlockContent(lines, i),
                        exported: !name.startsWith('_')
                    }));
                    continue;
                }
            }

            // Functions
            const funcMatch = originalLine.match(funcRegex);
            if (funcMatch) {
                const name = funcMatch[1];
                if (name.length >= this.config.minNameLength) {
                    patterns.push(this.createPatternEntry({
                        type: this.detectPythonFunctionType(name),
                        name,
                        file: relativePath,
                        line: lineNum,
                        endLine: this.findPythonBlockEnd(lines, i),
                        signature: `def ${name}(${funcMatch[2]})`,
                        description: this.getPythonDocstring(lines, i + 1),
                        keywords: this.extractKeywords(name),
                        content: this.getPythonBlockContent(lines, i),
                        exported: !name.startsWith('_')
                    }));
                    continue;
                }
            }

            // Constants
            const constMatch = originalLine.match(constRegex);
            if (constMatch) {
                const name = constMatch[1];
                if (name.length >= this.config.minNameLength) {
                    patterns.push(this.createPatternEntry({
                        type: 'constant',
                        name,
                        file: relativePath,
                        line: lineNum,
                        endLine: lineNum,
                        signature: `${name} = ...`,
                        description: '',
                        keywords: this.extractKeywords(name),
                        content: originalLine,
                        exported: !name.startsWith('_')
                    }));
                }
            }
        }

        return patterns;
    }

    private detectPythonClassType(name: string): PatternType {
        if (name.endsWith('Error') || name.endsWith('Exception')) return 'error';
        if (name.endsWith('Model')) return 'model';
        if (name.endsWith('Schema')) return 'schema';
        return 'class';
    }

    private detectPythonFunctionType(name: string): PatternType {
        if (name.startsWith('test_')) return 'function'; // Tests are filtered by indexTests config
        if (name.includes('middleware')) return 'middleware';
        if (name.includes('handler')) return 'handler';
        return 'function';
    }

    private getPythonDocstring(lines: string[], startIndex: number): string {
        if (startIndex >= lines.length) return '';
        const nextLine = lines[startIndex].trim();
        if (nextLine.startsWith('"""') || nextLine.startsWith("'''")) {
            const quote = nextLine.startsWith('"""') ? '"""' : "'''";
            let doc = nextLine.replace(quote, '');
            if (doc.endsWith(quote)) return doc.replace(quote, '').trim();

            for (let i = startIndex + 1; i < lines.length; i++) {
                if (lines[i].includes(quote)) {
                    doc += ' ' + lines[i].split(quote)[0].trim();
                    break;
                }
                doc += ' ' + lines[i].trim();
            }
            return doc.trim();
        }
        return '';
    }

    private findPythonBlockEnd(lines: string[], startIndex: number): number {
        const startIndent = lines[startIndex].search(/\S/);
        for (let i = startIndex + 1; i < lines.length; i++) {
            if (lines[i].trim() === '') continue;
            const currentIndent = lines[i].search(/\S/);
            if (currentIndent <= startIndent) return i;
        }
        return lines.length;
    }

    private getPythonBlockContent(lines: string[], startIndex: number): string {
        const endLine = this.findPythonBlockEnd(lines, startIndex);
        return lines.slice(startIndex, endLine).join('\n');
    }

    /**
     * Convert an AST node to a PatternEntry if applicable.
     */
    private nodeToPattern(
        node: ts.Node,
        sourceFile: ts.SourceFile,
        filePath: string,
        content: string
    ): PatternEntry | null {
        const startPos = sourceFile.getLineAndCharacterOfPosition(node.getStart());
        const endPos = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
        const line = startPos.line + 1;
        const endLine = endPos.line + 1;

        // Function declarations
        if (ts.isFunctionDeclaration(node) && node.name) {
            const name = node.name.text;
            if (name.length < this.config.minNameLength) return null;

            return this.createPatternEntry({
                type: this.detectFunctionType(name, node),
                name,
                file: filePath,
                line,
                endLine,
                signature: this.getFunctionSignature(node, sourceFile),
                description: this.getJSDocDescription(node, sourceFile),
                keywords: this.extractKeywords(name),
                content: node.getText(sourceFile),
                exported: this.isExported(node)
            });
        }

        // Variable declarations with arrow functions
        if (ts.isVariableStatement(node)) {
            const patterns: PatternEntry[] = [];
            for (const decl of node.declarationList.declarations) {
                if (ts.isIdentifier(decl.name) && decl.initializer) {
                    const name = decl.name.text;
                    if (name.length < this.config.minNameLength) continue;

                    if (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer)) {
                        return this.createPatternEntry({
                            type: this.detectFunctionType(name, decl.initializer),
                            name,
                            file: filePath,
                            line,
                            endLine,
                            signature: this.getArrowFunctionSignature(decl.initializer, sourceFile),
                            description: this.getJSDocDescription(node, sourceFile),
                            keywords: this.extractKeywords(name),
                            content: node.getText(sourceFile),
                            exported: this.isExported(node)
                        });
                    }

                    // Constants
                    if (ts.isStringLiteral(decl.initializer) ||
                        ts.isNumericLiteral(decl.initializer) ||
                        ts.isObjectLiteralExpression(decl.initializer)) {

                        const isConstant = node.declarationList.flags & ts.NodeFlags.Const;
                        if (isConstant && name === name.toUpperCase()) {
                            return this.createPatternEntry({
                                type: 'constant',
                                name,
                                file: filePath,
                                line,
                                endLine,
                                signature: '',
                                description: this.getJSDocDescription(node, sourceFile),
                                keywords: this.extractKeywords(name),
                                content: node.getText(sourceFile),
                                exported: this.isExported(node)
                            });
                        }
                    }
                }
            }
        }

        // Class declarations
        if (ts.isClassDeclaration(node) && node.name) {
            const name = node.name.text;
            if (name.length < this.config.minNameLength) return null;

            return this.createPatternEntry({
                type: this.detectClassType(name, node),
                name,
                file: filePath,
                line,
                endLine,
                signature: this.getClassSignature(node, sourceFile),
                description: this.getJSDocDescription(node, sourceFile),
                keywords: this.extractKeywords(name),
                content: node.getText(sourceFile),
                exported: this.isExported(node)
            });
        }

        // Interface declarations
        if (ts.isInterfaceDeclaration(node)) {
            const name = node.name.text;
            if (name.length < this.config.minNameLength) return null;

            return this.createPatternEntry({
                type: 'interface',
                name,
                file: filePath,
                line,
                endLine,
                signature: this.getInterfaceSignature(node, sourceFile),
                description: this.getJSDocDescription(node, sourceFile),
                keywords: this.extractKeywords(name),
                content: node.getText(sourceFile),
                exported: this.isExported(node)
            });
        }

        // Type alias declarations
        if (ts.isTypeAliasDeclaration(node)) {
            const name = node.name.text;
            if (name.length < this.config.minNameLength) return null;

            return this.createPatternEntry({
                type: 'type',
                name,
                file: filePath,
                line,
                endLine,
                signature: node.getText(sourceFile).split('=')[0].trim(),
                description: this.getJSDocDescription(node, sourceFile),
                keywords: this.extractKeywords(name),
                content: node.getText(sourceFile),
                exported: this.isExported(node)
            });
        }

        // Enum declarations
        if (ts.isEnumDeclaration(node)) {
            const name = node.name.text;
            if (name.length < this.config.minNameLength) return null;

            return this.createPatternEntry({
                type: 'enum',
                name,
                file: filePath,
                line,
                endLine,
                signature: `enum ${name}`,
                description: this.getJSDocDescription(node, sourceFile),
                keywords: this.extractKeywords(name),
                content: node.getText(sourceFile),
                exported: this.isExported(node)
            });
        }

        return null;
    }

    /**
     * Detect the specific type of a function based on naming conventions.
     */
    private detectFunctionType(name: string, node: ts.Node): PatternType {
        // React hooks
        if (name.startsWith('use') && name.length > 3 && name[3] === name[3].toUpperCase()) {
            return 'hook';
        }

        // React components (PascalCase and returns JSX)
        if (name[0] === name[0].toUpperCase() && this.containsJSX(node)) {
            return 'component';
        }

        // Middleware patterns
        if (name.includes('Middleware') || name.includes('middleware')) {
            return 'middleware';
        }

        // Handler patterns
        if (name.includes('Handler') || name.includes('handler')) {
            return 'handler';
        }

        // Factory patterns
        if (name.startsWith('create') || name.startsWith('make') || name.includes('Factory')) {
            return 'factory';
        }

        return 'function';
    }

    /**
     * Detect the specific type of a class.
     */
    private detectClassType(name: string, node: ts.ClassDeclaration): PatternType {
        // Error classes
        if (name.endsWith('Error') || name.endsWith('Exception')) {
            return 'error';
        }

        // Check for React component (extends Component/PureComponent)
        if (node.heritageClauses) {
            for (const clause of node.heritageClauses) {
                const text = clause.getText();
                if (text.includes('Component') || text.includes('PureComponent')) {
                    return 'component';
                }
            }
        }

        // Store patterns
        if (name.endsWith('Store') || name.endsWith('State')) {
            return 'store';
        }

        // Model patterns
        if (name.endsWith('Model') || name.endsWith('Entity')) {
            return 'model';
        }

        return 'class';
    }

    /**
     * Check if a node contains JSX.
     */
    private containsJSX(node: ts.Node): boolean {
        let hasJSX = false;
        const visit = (n: ts.Node) => {
            if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) {
                hasJSX = true;
                return;
            }
            ts.forEachChild(n, visit);
        };
        visit(node);
        return hasJSX;
    }

    /**
     * Get function signature.
     */
    private getFunctionSignature(node: ts.FunctionDeclaration, sourceFile: ts.SourceFile): string {
        const params = node.parameters
            .map(p => p.getText(sourceFile))
            .join(', ');
        const returnType = node.type ? `: ${node.type.getText(sourceFile)}` : '';
        return `(${params})${returnType}`;
    }

    /**
     * Get arrow function signature.
     */
    private getArrowFunctionSignature(
        node: ts.ArrowFunction | ts.FunctionExpression,
        sourceFile: ts.SourceFile
    ): string {
        const params = node.parameters
            .map(p => p.getText(sourceFile))
            .join(', ');
        const returnType = node.type ? `: ${node.type.getText(sourceFile)}` : '';
        return `(${params})${returnType}`;
    }

    /**
     * Get class signature.
     */
    private getClassSignature(node: ts.ClassDeclaration, sourceFile: ts.SourceFile): string {
        let sig = `class ${node.name?.text || 'Anonymous'}`;
        if (node.heritageClauses) {
            sig += ' ' + node.heritageClauses.map(c => c.getText(sourceFile)).join(' ');
        }
        return sig;
    }

    /**
     * Get interface signature.
     */
    private getInterfaceSignature(node: ts.InterfaceDeclaration, sourceFile: ts.SourceFile): string {
        let sig = `interface ${node.name.text}`;
        if (node.typeParameters) {
            sig += `<${node.typeParameters.map(p => p.getText(sourceFile)).join(', ')}>`;
        }
        return sig;
    }

    /**
     * Extract JSDoc description from a node.
     */
    private getJSDocDescription(node: ts.Node, sourceFile: ts.SourceFile): string {
        const jsDocTags = ts.getJSDocTags(node);
        const jsDocComment = ts.getJSDocCommentsAndTags(node);

        for (const tag of jsDocComment) {
            if (ts.isJSDoc(tag) && tag.comment) {
                if (typeof tag.comment === 'string') {
                    return tag.comment;
                }
                return tag.comment.map(c => c.getText(sourceFile)).join(' ');
            }
        }

        return '';
    }

    /**
     * Check if a node is exported.
     */
    private isExported(node: ts.Node): boolean {
        if (ts.canHaveModifiers(node)) {
            const modifiers = ts.getModifiers(node);
            if (modifiers) {
                return modifiers.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
            }
        }
        return false;
    }

    /**
     * Extract keywords from a name for semantic matching.
     */
    private extractKeywords(name: string): string[] {
        // Split camelCase and PascalCase
        const words = name
            .replace(/([a-z])([A-Z])/g, '$1 $2')
            .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
            .toLowerCase()
            .split(/[\s_-]+/)
            .filter(w => w.length > 1);

        return [...new Set(words)];
    }

    /**
     * Create a PatternEntry with computed fields.
     */
    private createPatternEntry(params: {
        type: PatternType;
        name: string;
        file: string;
        line: number;
        endLine: number;
        signature: string;
        description: string;
        keywords: string[];
        content: string;
        exported: boolean;
    }): PatternEntry {
        const id = this.hashContent(`${params.file}:${params.name}:${params.line}`);
        const hash = this.hashContent(params.content);

        return {
            id,
            type: params.type,
            name: params.name,
            file: params.file,
            line: params.line,
            endLine: params.endLine,
            signature: params.signature,
            description: params.description,
            keywords: params.keywords,
            hash,
            exported: params.exported,
            usageCount: 0, // Will be calculated in a separate pass
            indexedAt: new Date().toISOString()
        };
    }

    /**
     * Get the TypeScript ScriptKind for a file.
     */
    private getScriptKind(filePath: string): ts.ScriptKind {
        const ext = path.extname(filePath).toLowerCase();
        switch (ext) {
            case '.ts': return ts.ScriptKind.TS;
            case '.tsx': return ts.ScriptKind.TSX;
            case '.js': return ts.ScriptKind.JS;
            case '.jsx': return ts.ScriptKind.JSX;
            default: return ts.ScriptKind.TS;
        }
    }

    /**
     * Calculate index statistics.
     */
    private calculateStats(
        patterns: PatternEntry[],
        files: IndexedFile[],
        durationMs: number
    ): PatternIndexStats {
        const byType: Record<string, number> = {};

        for (const pattern of patterns) {
            byType[pattern.type] = (byType[pattern.type] || 0) + 1;
        }

        return {
            totalPatterns: patterns.length,
            totalFiles: files.length,
            byType: byType as Record<PatternType, number>,
            indexDurationMs: durationMs
        };
    }

    /**
     * Hash content using SHA-256.
     */
    private hashContent(content: string): string {
        return createHash('sha256').update(content).digest('hex').slice(0, 16);
    }
}

/**
 * Save a pattern index to disk.
 */
export async function savePatternIndex(index: PatternIndex, outputPath: string): Promise<void> {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, JSON.stringify(index, null, 2), 'utf-8');
}

/**
 * Load a pattern index from disk.
 */
export async function loadPatternIndex(indexPath: string): Promise<PatternIndex | null> {
    try {
        const content = await fs.readFile(indexPath, 'utf-8');
        return JSON.parse(content) as PatternIndex;
    } catch {
        return null;
    }
}

/**
 * Get the default index path for a project.
 */
export function getDefaultIndexPath(rootDir: string): string {
    return path.join(rootDir, '.rigour', 'patterns.json');
}
