import { describe, expect, it } from 'vitest';
import type { Failure } from '../types/index.js';
import { blockingByCheck } from './blocking-checks.js';

const failure = (id: string, details: string): Failure => ({ id, title: id, details, files: ['src/a.ts'], line: 3 } as Failure);

describe('blockingByCheck', () => {
    it('ties a blocking finding to the review check that produced it, through a re-anchored copy', () => {
        const produced = failure('unused-export', 'export f is used nowhere');
        const owner = new Map([[produced, 'unused-exports']]);
        expect(blockingByCheck([{ ...produced, anchorLine: 4 }], [produced], owner)).toEqual({ 'unused-exports': 1 });
    });

    it('counts a finding two checks produced for each of them', () => {
        const first = failure('compiled-lesson', 'page every query');
        const second = failure('compiled-lesson', 'page every query');
        const owner = new Map([[first, 'compiled-lessons'], [second, 'query-patterns']]);
        expect(blockingByCheck([{ ...first }], [first, second], owner)).toEqual({ 'compiled-lessons': 1, 'query-patterns': 1 });
    });

    it('counts a finding no check owns under its own rule id', () => {
        expect(blockingByCheck([failure('diff-tests', 'changed output')], [], new Map())).toEqual({ 'diff-tests': 1 });
    });
});
