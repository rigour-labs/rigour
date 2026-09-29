import { describe, expect, it } from 'vitest';
import { parseFindings } from './parse-findings.js';

const finding = { category: 'correctness', severity: 'high', file: 'a.ts', line: 3, description: 'bug', suggestion: 'fix', confidence: 0.8 };

describe('parseFindings', () => {
    it('parses a findings object, a bare array and fenced JSON', () => {
        expect(parseFindings(JSON.stringify({ findings: [finding] }))).toHaveLength(1);
        expect(parseFindings(JSON.stringify([finding]))).toHaveLength(1);
        expect(parseFindings('Here you go:\n```json\n' + JSON.stringify({ findings: [finding] }) + '\n```')).toHaveLength(1);
    });

    it('recovers complete findings from a response cut off by the token budget', () => {
        const cut = `{"findings": [${JSON.stringify(finding)}, {"category": "security", "severity": "hi`;
        expect(parseFindings(cut)).toEqual([finding]);
    });

    it('drops malformed entries and normalises confidence and severity', () => {
        const parsed = parseFindings(JSON.stringify({ findings: [
            { ...finding, severity: 'urgent', confidence: 7 },
            { category: 'x', description: 'no file' },
        ] }));
        expect(parsed).toEqual([{ ...finding, severity: 'medium', confidence: 0.5 }]);
    });

    it('returns nothing for empty or non-JSON output', () => {
        expect(parseFindings('')).toEqual([]);
        expect(parseFindings('I could not find any issues.')).toEqual([]);
    });
});
