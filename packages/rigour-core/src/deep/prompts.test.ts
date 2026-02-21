import { describe, it, expect } from 'vitest';
import { buildAnalysisPrompt, buildCrossFilePrompt, chunkFacts, DEEP_SYSTEM_PROMPT } from './prompts.js';
import type { FileFacts } from './fact-extractor.js';

// ── Test helpers ──

function makeGoFacts(overrides: Partial<FileFacts> = {}): FileFacts {
    return {
        path: 'pkg/server.go',
        language: 'go',
        lineCount: 200,
        classes: [],
        functions: [{
            name: 'Server.Start',
            lineStart: 10,
            lineEnd: 50,
            lineCount: 40,
            paramCount: 1,
            params: ['ctx context.Context'],
            maxNesting: 3,
            hasReturn: true,
            isAsync: false,
            isExported: true,
        }],
        imports: ['net/http', 'context', 'sync'],
        exports: [],
        errorHandling: [],
        testAssertions: 0,
        hasTests: false,
        structs: [{
            name: 'Server',
            lineStart: 5,
            lineEnd: 15,
            fieldCount: 5,
            methodCount: 4,
            methods: ['Start', 'Stop', 'Handle', 'Route'],
            lineCount: 10,
            embeds: ['BaseServer'],
        }],
        interfaces: [{
            name: 'Handler',
            lineStart: 20,
            methodCount: 2,
            methods: ['ServeHTTP', 'Health'],
        }],
        goroutines: 3,
        channels: 1,
        mutexes: 1,
        defers: 2,
        ...overrides,
    };
}

function makeTsFacts(overrides: Partial<FileFacts> = {}): FileFacts {
    return {
        path: 'src/service.ts',
        language: 'typescript',
        lineCount: 150,
        classes: [{
            name: 'UserService',
            lineStart: 5,
            lineEnd: 140,
            methodCount: 6,
            methods: ['find', 'create', 'update', 'delete', 'validate', 'notify'],
            publicMethods: ['find', 'create', 'update', 'delete'],
            lineCount: 135,
            dependencies: ['Database', 'Logger'],
        }],
        functions: [],
        imports: ['express', 'lodash', './types'],
        exports: ['UserService'],
        errorHandling: [
            { type: 'try-catch', lineStart: 10, isEmpty: false, strategy: 'throw' },
        ],
        testAssertions: 0,
        hasTests: false,
        ...overrides,
    };
}

describe('Deep Analysis Prompts', () => {
    // ── DEEP_SYSTEM_PROMPT ──

    describe('DEEP_SYSTEM_PROMPT', () => {
        it('should contain all category groups', () => {
            expect(DEEP_SYSTEM_PROMPT).toContain('SOLID Principles');
            expect(DEEP_SYSTEM_PROMPT).toContain('Design Patterns');
            expect(DEEP_SYSTEM_PROMPT).toContain('DRY');
            expect(DEEP_SYSTEM_PROMPT).toContain('Error Handling');
            expect(DEEP_SYSTEM_PROMPT).toContain('Concurrency');
            expect(DEEP_SYSTEM_PROMPT).toContain('Testing');
        });

        it('should contain key category IDs', () => {
            expect(DEEP_SYSTEM_PROMPT).toContain('god_class');
            expect(DEEP_SYSTEM_PROMPT).toContain('god_function');
            expect(DEEP_SYSTEM_PROMPT).toContain('srp_violation');
            expect(DEEP_SYSTEM_PROMPT).toContain('race_condition');
            expect(DEEP_SYSTEM_PROMPT).toContain('empty_catch');
            expect(DEEP_SYSTEM_PROMPT).toContain('missing_test');
        });

        it('should include output schema', () => {
            expect(DEEP_SYSTEM_PROMPT).toContain('"findings"');
            expect(DEEP_SYSTEM_PROMPT).toContain('"category"');
            expect(DEEP_SYSTEM_PROMPT).toContain('"severity"');
            expect(DEEP_SYSTEM_PROMPT).toContain('"confidence"');
        });

        it('should contain Go-specific guidance', () => {
            expect(DEEP_SYSTEM_PROMPT).toContain('Go code');
            expect(DEEP_SYSTEM_PROMPT).toContain('struct');
            expect(DEEP_SYSTEM_PROMPT).toContain('receiver method');
        });
    });

    // ── buildAnalysisPrompt ──

    describe('buildAnalysisPrompt', () => {
        it('should build prompt with default checks', () => {
            const factsStr = 'FILE: src/service.ts (typescript, 150 lines)';
            const prompt = buildAnalysisPrompt(factsStr);

            // Default checks include descriptions for SOLID, DRY, design patterns
            expect(prompt).toContain('SOLID');
            expect(prompt).toContain('DRY');
            expect(prompt).toContain('god class');
            expect(prompt).toContain(factsStr);
        });

        it('should include language-specific guidance for Go', () => {
            const factsStr = 'FILE: pkg/server.go (go, 200 lines)\n  STRUCT Server (10 lines, 5 fields)';
            const prompt = buildAnalysisPrompt(factsStr);

            // Should detect Go as dominant language and add Go guidance
            expect(prompt.toLowerCase()).toContain('go');
        });

        it('should include language-specific guidance for TypeScript', () => {
            const factsStr = 'FILE: src/service.ts (typescript, 150 lines)\n  CLASS UserService';
            const prompt = buildAnalysisPrompt(factsStr);

            expect(prompt.toLowerCase()).toContain('typescript');
        });

        it('should respect custom check selection', () => {
            const factsStr = 'FILE: src/service.ts (typescript, 150 lines)';
            const checks = {
                solid: true,
                dry: false,
                design_patterns: false,
                concurrency: true,
            };
            const prompt = buildAnalysisPrompt(factsStr, checks);

            expect(prompt).toContain('SOLID');
            expect(prompt).toContain('Concurrency');
        });
    });

    // ── buildCrossFilePrompt ──

    describe('buildCrossFilePrompt', () => {
        it('should analyze patterns across multiple files', () => {
            const allFacts: FileFacts[] = [
                makeTsFacts({ path: 'src/user.service.ts' }),
                makeTsFacts({
                    path: 'src/order.service.ts',
                    classes: [{
                        name: 'OrderService',
                        lineStart: 1,
                        lineEnd: 100,
                        methodCount: 5,
                        methods: ['find', 'create', 'update', 'delete', 'process'],
                        publicMethods: ['find', 'create'],
                        lineCount: 100,
                        dependencies: ['Database', 'Logger'],
                    }],
                }),
                makeTsFacts({
                    path: 'src/product.service.ts',
                    errorHandling: [
                        { type: 'try-catch', lineStart: 5, isEmpty: false, strategy: 'log' },
                        { type: 'try-catch', lineStart: 15, isEmpty: false, strategy: 'throw' },
                    ],
                }),
            ];

            const prompt = buildCrossFilePrompt(allFacts);
            expect(prompt).toBeDefined();
            expect(prompt.length).toBeGreaterThan(0);
            // Should reference file count
            expect(prompt).toContain('3');
        });

        it('should include Go-specific cross-file info', () => {
            const allFacts: FileFacts[] = [
                makeGoFacts({ path: 'pkg/server.go' }),
                makeGoFacts({
                    path: 'pkg/handler.go',
                    structs: [{
                        name: 'Handler',
                        lineStart: 1,
                        lineEnd: 50,
                        fieldCount: 3,
                        methodCount: 5,
                        methods: ['Get', 'Post', 'Put', 'Delete', 'Options'],
                        lineCount: 50,
                        embeds: [],
                    }],
                }),
            ];

            const prompt = buildCrossFilePrompt(allFacts);
            expect(prompt).toBeDefined();
            expect(prompt.length).toBeGreaterThan(0);
        });
    });

    // ── chunkFacts ──

    describe('chunkFacts', () => {
        it('should split facts into token-limited chunks', () => {
            const manyFacts: FileFacts[] = Array.from({ length: 50 }, (_, i) =>
                makeTsFacts({
                    path: `src/file${i}.ts`,
                    lineCount: 200,
                })
            );

            const chunks = chunkFacts(manyFacts, 4000);
            expect(chunks.length).toBeGreaterThan(1);

            // All facts should be distributed across chunks
            const totalFiles = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
            expect(totalFiles).toBe(50);
        });

        it('should handle single file within budget', () => {
            const facts = [makeTsFacts()];
            const chunks = chunkFacts(facts, 10000);
            expect(chunks).toHaveLength(1);
            expect(chunks[0]).toHaveLength(1);
        });

        it('should handle empty input', () => {
            const chunks = chunkFacts([], 4000);
            expect(chunks).toHaveLength(0);
        });
    });
});
