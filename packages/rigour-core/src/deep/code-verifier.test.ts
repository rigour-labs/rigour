import { describe, expect, it } from 'vitest';
import { quotedIdentifiers, verifyCodeFindings } from './code-verifier.js';
import type { CodeContext } from './code-context.js';
import type { DeepFinding } from '../inference/types.js';

const context: CodeContext = {
    file: 'src/api/report.ts',
    language: 'typescript',
    text: '',
    ranges: [[10, 40]],
    source: 'export async function loadReport(days) {\n  const rows = await fetchAll(days);\n}',
};

function finding(overrides: Partial<DeepFinding>): DeepFinding {
    return {
        category: 'scalability', severity: 'high', file: 'src/api/report.ts', line: 12,
        description: '`fetchAll` loads every row for the window into memory.', suggestion: 'Aggregate in the database.',
        confidence: 0.8, ...overrides,
    };
}

describe('verifyCodeFindings', () => {
    it('keeps a finding grounded in the sent source', () => {
        const [kept] = verifyCodeFindings([finding({})], [context]);
        expect(kept).toMatchObject({ file: 'src/api/report.ts', verified: true });
    });

    it('resolves a basename-only file for a single-file review', () => {
        expect(verifyCodeFindings([finding({ file: 'report.ts' })], [context])).toHaveLength(1);
    });

    it('drops findings for files that were not sent', () => {
        expect(verifyCodeFindings([finding({ file: 'src/other.ts' })], [context])).toHaveLength(0);
    });

    it('drops findings whose line is outside the sent ranges', () => {
        expect(verifyCodeFindings([finding({ line: 80 })], [context])).toHaveLength(0);
    });

    it('drops findings that cite an identifier the model was never shown', () => {
        expect(verifyCodeFindings([finding({ description: '`fetchEverything` has no limit.' })], [context])).toHaveLength(0);
    });

    it('drops findings that cite no line, however confident', () => {
        expect(verifyCodeFindings([finding({ line: undefined, confidence: 0.9 })], [context])).toHaveLength(0);
        expect(verifyCodeFindings([finding({ line: null as unknown as number, description: 'The code is well-structured.' })], [context])).toHaveLength(0);
    });

    it('drops very low confidence findings', () => {
        expect(verifyCodeFindings([finding({ confidence: 0.2 })], [context])).toHaveLength(0);
    });
});

describe('quotedIdentifiers', () => {
    it('extracts identifier-like backticked tokens only', () => {
        expect(quotedIdentifiers('`fetchAll()` and `rows.length` but not `a + b` or `"quoted"`')).toEqual(['fetchAll', 'rows.length']);
    });
});
