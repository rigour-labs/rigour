import { describe, it, expect } from 'vitest';
import { verifyFindings, type VerifiedFinding } from './verifier.js';
import type { FileFacts } from './fact-extractor.js';
import type { DeepFinding } from '../inference/types.js';

// ── Test helpers ──

function makeFinding(overrides: Partial<DeepFinding> = {}): DeepFinding {
    return {
        category: 'god_class',
        severity: 'high',
        file: 'src/service.ts',
        line: 10,
        description: 'The UserService class has too many responsibilities',
        suggestion: 'Split into smaller services',
        confidence: 0.8,
        ...overrides,
    };
}

function makeFileFacts(overrides: Partial<FileFacts> = {}): FileFacts {
    return {
        path: 'src/service.ts',
        language: 'typescript',
        lineCount: 300,
        classes: [{
            name: 'UserService',
            lineStart: 5,
            lineEnd: 290,
            methodCount: 12,
            methods: ['find', 'create', 'update', 'delete', 'validate', 'transform', 'cache', 'notify', 'log', 'serialize', 'auth', 'batch'],
            publicMethods: ['find', 'create', 'update', 'delete'],
            lineCount: 285,
            dependencies: ['Database', 'Logger'],
        }],
        functions: [{
            name: 'processData',
            lineStart: 10,
            lineEnd: 80,
            lineCount: 70,
            paramCount: 5,
            params: ['a', 'b', 'c', 'd', 'e'],
            maxNesting: 4,
            hasReturn: true,
            isAsync: true,
            isExported: true,
        }],
        imports: ['express', './types'],
        exports: ['UserService'],
        errorHandling: [
            { type: 'try-catch', lineStart: 20, isEmpty: false, strategy: 'throw' },
            { type: 'try-catch', lineStart: 50, isEmpty: true, strategy: 'ignore' },
        ],
        testAssertions: 0,
        hasTests: false,
        ...overrides,
    };
}

describe('Verifier', () => {
    // ── File existence ──

    describe('file existence check', () => {
        it('should drop findings for files not in facts', () => {
            const findings = [makeFinding({ file: 'src/nonexistent.ts' })];
            const facts = [makeFileFacts()];
            const result = verifyFindings(findings, facts);
            expect(result).toHaveLength(0);
        });

        it('should accept findings for files that exist', () => {
            const findings = [makeFinding()];
            const facts = [makeFileFacts()];
            const result = verifyFindings(findings, facts);
            expect(result).toHaveLength(1);
            expect(result[0].verified).toBe(true);
        });

        it('should handle path normalization (leading ./)', () => {
            const findings = [makeFinding({ file: './src/service.ts' })];
            const facts = [makeFileFacts()];
            const result = verifyFindings(findings, facts);
            expect(result).toHaveLength(1);
        });
    });

    // ── Class/Struct findings (SOLID) ──

    describe('class/struct-based verification', () => {
        it('should verify god_class when class has many methods', () => {
            const findings = [makeFinding({ category: 'god_class' })];
            const facts = [makeFileFacts()];
            const result = verifyFindings(findings, facts);
            expect(result).toHaveLength(1);
            expect(result[0].verified).toBe(true);
            expect(result[0].verificationNotes).toContain('12 methods');
        });

        it('should reject god_class when class is small', () => {
            const findings = [makeFinding({ category: 'god_class' })];
            const facts = [makeFileFacts({
                classes: [{
                    name: 'UserService',
                    lineStart: 5,
                    lineEnd: 30,
                    methodCount: 3,
                    methods: ['find', 'create', 'update'],
                    publicMethods: ['find', 'create'],
                    lineCount: 25,
                    dependencies: [],
                }],
            })];
            const result = verifyFindings(findings, facts);
            expect(result).toHaveLength(0);
        });

        it('should accept god_class for Go structs', () => {
            const findings = [makeFinding({
                category: 'god_class',
                file: 'pkg/server.go',
                description: 'The Server struct has too many responsibilities',
            })];
            const facts = [makeFileFacts({
                path: 'pkg/server.go',
                language: 'go',
                classes: [],
                structs: [{
                    name: 'Server',
                    lineStart: 5,
                    lineEnd: 250,
                    fieldCount: 8,
                    methodCount: 10,
                    methods: ['Start', 'Stop', 'Handle', 'Route', 'Auth', 'Log', 'Cache', 'Validate', 'Transform', 'Serialize'],
                    lineCount: 245,
                    embeds: [],
                }],
            })];
            const result = verifyFindings(findings, facts);
            expect(result).toHaveLength(1);
            expect(result[0].verified).toBe(true);
        });

        it('should accept Go module-level god_class when file has many functions', () => {
            const findings = [makeFinding({
                category: 'god_class',
                file: 'pkg/utils.go',
                description: 'This module has too many responsibilities',
            })];
            const facts = [makeFileFacts({
                path: 'pkg/utils.go',
                language: 'go',
                classes: [],
                structs: [],
                functions: Array.from({ length: 15 }, (_, i) => ({
                    name: `func${i}`,
                    lineStart: i * 20,
                    lineEnd: i * 20 + 15,
                    lineCount: 15,
                    paramCount: 2,
                    params: ['a', 'b'],
                    maxNesting: 2,
                    hasReturn: true,
                    isAsync: false,
                    isExported: true,
                })),
            })];
            const result = verifyFindings(findings, facts);
            expect(result).toHaveLength(1);
            expect(result[0].verified).toBe(true);
            expect(result[0].verificationNotes).toContain('15 functions');
        });

        it('should reject when entity name not found in file', () => {
            const findings = [makeFinding({
                category: 'srp_violation',
                description: 'The NonExistentClass has too many responsibilities',
            })];
            const facts = [makeFileFacts()];
            const result = verifyFindings(findings, facts);
            // Should still verify since file has classes with confidence >= 0.4
            expect(result).toHaveLength(1);
        });
    });

    // ── Function findings ──

    describe('function-based verification', () => {
        it('should verify god_function when function is long', () => {
            const findings = [makeFinding({
                category: 'god_function',
                description: 'processData is too long and complex',
            })];
            const facts = [makeFileFacts()];
            const result = verifyFindings(findings, facts);
            expect(result).toHaveLength(1);
            expect(result[0].verified).toBe(true);
        });

        it('should reject god_function when function is short', () => {
            const findings = [makeFinding({
                category: 'god_function',
                description: 'processData is too complex',
            })];
            const facts = [makeFileFacts({
                functions: [{
                    name: 'processData',
                    lineStart: 10,
                    lineEnd: 25,
                    lineCount: 15,
                    paramCount: 2,
                    params: ['a', 'b'],
                    maxNesting: 1,
                    hasReturn: true,
                    isAsync: false,
                    isExported: true,
                }],
            })];
            const result = verifyFindings(findings, facts);
            expect(result).toHaveLength(0);
        });

        it('should verify long_params when function has many params', () => {
            const findings = [makeFinding({
                category: 'long_params',
                description: 'processData has too many parameters',
            })];
            const facts = [makeFileFacts()];
            const result = verifyFindings(findings, facts);
            expect(result).toHaveLength(1);
            expect(result[0].verified).toBe(true);
        });

        it('should reject long_params when function has few params', () => {
            const findings = [makeFinding({
                category: 'long_params',
                description: 'processData has too many parameters',
            })];
            const facts = [makeFileFacts({
                functions: [{
                    name: 'processData',
                    lineStart: 10,
                    lineEnd: 50,
                    lineCount: 40,
                    paramCount: 2,
                    params: ['a', 'b'],
                    maxNesting: 2,
                    hasReturn: true,
                    isAsync: false,
                    isExported: true,
                }],
            })];
            const result = verifyFindings(findings, facts);
            expect(result).toHaveLength(0);
        });

        it('should verify complex_conditional when nesting is deep', () => {
            const findings = [makeFinding({
                category: 'complex_conditional',
                description: 'processData has deeply nested conditionals',
            })];
            const facts = [makeFileFacts()];
            const result = verifyFindings(findings, facts);
            expect(result).toHaveLength(1);
            expect(result[0].verified).toBe(true);
        });
    });

    // ── Error handling findings ──

    describe('error handling verification', () => {
        it('should verify empty_catch when empty catches exist', () => {
            const findings = [makeFinding({
                category: 'empty_catch',
                description: 'Empty catch block silently swallows errors',
            })];
            const facts = [makeFileFacts()];
            const result = verifyFindings(findings, facts);
            expect(result).toHaveLength(1);
            expect(result[0].verified).toBe(true);
        });

        it('should reject empty_catch when no empty catches exist', () => {
            const findings = [makeFinding({
                category: 'empty_catch',
                description: 'Empty catch block',
            })];
            const facts = [makeFileFacts({
                errorHandling: [
                    { type: 'try-catch', lineStart: 10, isEmpty: false, strategy: 'throw' },
                ],
            })];
            const result = verifyFindings(findings, facts);
            expect(result).toHaveLength(0);
        });

        it('should verify error_inconsistency when multiple strategies exist', () => {
            const findings = [makeFinding({
                category: 'error_inconsistency',
                description: 'Mixed error handling strategies',
            })];
            const facts = [makeFileFacts()]; // Has 'throw' and 'ignore' strategies
            const result = verifyFindings(findings, facts);
            expect(result).toHaveLength(1);
            expect(result[0].verified).toBe(true);
        });
    });

    // ── Concurrency findings ──

    describe('concurrency verification', () => {
        const goFacts = (): FileFacts => makeFileFacts({
            path: 'pkg/worker.go',
            language: 'go',
            goroutines: 3,
            channels: 2,
            mutexes: 1,
            defers: 2,
        });

        it('should verify race_condition when concurrency constructs exist', () => {
            const findings = [makeFinding({
                category: 'race_condition',
                file: 'pkg/worker.go',
                description: 'Potential race condition',
                confidence: 0.6,
            })];
            const result = verifyFindings(findings, [goFacts()]);
            expect(result).toHaveLength(1);
            expect(result[0].verified).toBe(true);
        });

        it('should reject goroutine_leak when no goroutines exist', () => {
            const findings = [makeFinding({
                category: 'goroutine_leak',
                file: 'pkg/worker.go',
                description: 'Goroutine leak detected',
                confidence: 0.7,
            })];
            const facts = goFacts();
            facts.goroutines = 0;
            const result = verifyFindings(findings, [facts]);
            expect(result).toHaveLength(0);
        });

        it('should reject channel_misuse when no channels exist', () => {
            const findings = [makeFinding({
                category: 'channel_misuse',
                file: 'pkg/worker.go',
                description: 'Channel misuse detected',
                confidence: 0.7,
            })];
            const facts = goFacts();
            facts.channels = 0;
            const result = verifyFindings(findings, [facts]);
            expect(result).toHaveLength(0);
        });

        it('should reject concurrency finding when no concurrency exists', () => {
            const findings = [makeFinding({
                category: 'race_condition',
                file: 'pkg/worker.go',
                description: 'Race condition',
                confidence: 0.8,
            })];
            const facts = goFacts();
            facts.goroutines = 0;
            facts.channels = 0;
            facts.mutexes = 0;
            facts.functions = facts.functions.map(f => ({ ...f, isAsync: false }));
            const result = verifyFindings(findings, [facts]);
            expect(result).toHaveLength(0);
        });
    });

    // ── Interface findings ──

    describe('interface verification', () => {
        it('should verify ISP violation on large interface', () => {
            const findings = [makeFinding({
                category: 'isp_violation_interface',
                file: 'pkg/store.go',
                description: 'Store interface has too many methods',
                confidence: 0.8,
            })];
            const facts = [makeFileFacts({
                path: 'pkg/store.go',
                language: 'go',
                interfaces: [{
                    name: 'Store',
                    lineStart: 5,
                    methodCount: 8,
                    methods: ['Get', 'Set', 'Delete', 'List', 'Close', 'Watch', 'Backup', 'Restore'],
                }],
            })];
            const result = verifyFindings(findings, facts);
            expect(result).toHaveLength(1);
            expect(result[0].verified).toBe(true);
        });

        it('should reject ISP violation when no interfaces exist', () => {
            const findings = [makeFinding({
                category: 'isp_violation_interface',
                file: 'pkg/store.go',
                description: 'Interface has too many methods',
            })];
            const facts = [makeFileFacts({
                path: 'pkg/store.go',
                interfaces: [],
            })];
            const result = verifyFindings(findings, facts);
            expect(result).toHaveLength(0);
        });
    });

    // ── Test findings ──

    describe('test verification', () => {
        it('should verify missing_test for substantial code files', () => {
            const findings = [makeFinding({
                category: 'missing_test',
                description: 'No tests for this module',
            })];
            const facts = [makeFileFacts({
                functions: [
                    { name: 'processData', lineStart: 10, lineEnd: 80, lineCount: 70, paramCount: 5, params: ['a','b','c','d','e'], maxNesting: 4, hasReturn: true, isAsync: true, isExported: true },
                    { name: 'helperFn', lineStart: 85, lineEnd: 100, lineCount: 15, paramCount: 1, params: ['x'], maxNesting: 1, hasReturn: true, isAsync: false, isExported: false },
                ],
            })]; // hasTests: false, 300 lines, 2 functions
            const result = verifyFindings(findings, facts);
            expect(result).toHaveLength(1);
            expect(result[0].verified).toBe(true);
        });

        it('should reject missing_test when file already has tests', () => {
            const findings = [makeFinding({
                category: 'missing_test',
                description: 'No tests',
            })];
            const facts = [makeFileFacts({ hasTests: true })];
            const result = verifyFindings(findings, facts);
            expect(result).toHaveLength(0);
        });

        it('should reject missing_test for trivial files', () => {
            const findings = [makeFinding({
                category: 'missing_test',
                description: 'No tests',
            })];
            const facts = [makeFileFacts({ lineCount: 20, functions: [] })];
            const result = verifyFindings(findings, facts);
            expect(result).toHaveLength(0);
        });
    });

    // ── File-level categories ──

    describe('file-level verification', () => {
        it('should verify long_file when file exceeds 300 lines', () => {
            const findings = [makeFinding({ category: 'long_file' })];
            const facts = [makeFileFacts({ lineCount: 500 })];
            const result = verifyFindings(findings, facts);
            expect(result).toHaveLength(1);
            expect(result[0].verified).toBe(true);
        });

        it('should reject long_file when file is short', () => {
            const findings = [makeFinding({ category: 'long_file' })];
            const facts = [makeFileFacts({ lineCount: 100 })];
            const result = verifyFindings(findings, facts);
            expect(result).toHaveLength(0);
        });

        it('should verify magic_number when many magic numbers detected', () => {
            const findings = [makeFinding({ category: 'magic_number' })];
            const facts = [makeFileFacts({ magicNumbers: 10 })];
            const result = verifyFindings(findings, facts);
            expect(result).toHaveLength(1);
        });

        it('should reject magic_number when few magic numbers detected', () => {
            const findings = [makeFinding({ category: 'magic_number' })];
            const facts = [makeFileFacts({ magicNumbers: 1 })];
            const result = verifyFindings(findings, facts);
            expect(result).toHaveLength(0);
        });
    });

    // ── Confidence-based categories ──

    describe('confidence-based verification', () => {
        const confidenceCategories = [
            'dry_violation', 'feature_envy', 'architecture',
            'naming_convention', 'dead_code', 'performance',
        ];

        for (const category of confidenceCategories) {
            it(`should accept ${category} with confidence >= 0.3`, () => {
                const findings = [makeFinding({ category, confidence: 0.5 })];
                const facts = [makeFileFacts()];
                const result = verifyFindings(findings, facts);
                expect(result).toHaveLength(1);
            });

            it(`should reject ${category} with low confidence`, () => {
                const findings = [makeFinding({ category, confidence: 0.1 })];
                const facts = [makeFileFacts()];
                const result = verifyFindings(findings, facts);
                expect(result).toHaveLength(0);
            });
        }
    });

    // ── Resource leak (Go-specific) ──

    describe('resource leak verification', () => {
        it('should verify Go resource leak when resource imports present', () => {
            const findings = [makeFinding({
                category: 'resource_leak',
                file: 'pkg/db.go',
                confidence: 0.6,
            })];
            const facts = [makeFileFacts({
                path: 'pkg/db.go',
                language: 'go',
                imports: ['database/sql', 'net/http'],
            })];
            const result = verifyFindings(findings, facts);
            expect(result).toHaveLength(1);
            expect(result[0].verified).toBe(true);
        });

        it('should reject Go resource leak when no resource imports', () => {
            const findings = [makeFinding({
                category: 'resource_leak',
                file: 'pkg/util.go',
                confidence: 0.6,
            })];
            const facts = [makeFileFacts({
                path: 'pkg/util.go',
                language: 'go',
                imports: ['fmt', 'strings'],
            })];
            const result = verifyFindings(findings, facts);
            expect(result).toHaveLength(0);
        });
    });

    // ── Multiple findings batch ──

    describe('batch verification', () => {
        it('should process multiple findings and filter correctly', () => {
            const findings: DeepFinding[] = [
                makeFinding({ category: 'god_class' }),                                    // Should pass (12 methods)
                makeFinding({ category: 'god_function', file: 'nonexistent.ts' }),         // Should fail (no file)
                makeFinding({ category: 'long_file' }),                                     // Should fail (300 lines, need >300)
                makeFinding({ category: 'magic_number' }),                                  // Should fail (no magicNumbers set)
                makeFinding({ category: 'dry_violation', confidence: 0.1 }),               // Should fail (low confidence)
                makeFinding({ category: 'dry_violation', confidence: 0.5 }),               // Should pass
            ];
            const facts = [makeFileFacts()];
            const result = verifyFindings(findings, facts);

            const verified = result.filter(r => r.verified);
            expect(verified.length).toBeGreaterThanOrEqual(2); // god_class, dry_violation(0.5)
        });
    });
});
