import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveLearnedRule, type LearnedRule } from '@rigour-labs/core';
import { loadStudioLearnedRules } from './studio-learned-rules.js';

const base: Omit<LearnedRule, 'id' | 'pattern'> = {
    version: 1, message: 'm', severity: 'medium',
    source: { commit: 'abc12345', file: 'src/http.ts', function: 'post' },
    validation: { firesBefore: 1, firesAfter: 0, maxHits: 3, repoHits: ['src/other.ts:4'] },
};

describe('loadStudioLearnedRules', () => {
    let cwd: string | undefined;
    afterEach(() => { if (cwd) fs.rmSync(cwd, { recursive: true, force: true }); cwd = undefined; });

    it('describes each rule by what it requires and where it applies', () => {
        cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-learned-'));
        saveLearnedRule(cwd, { ...base, id: 'require-option-redirect-aaaa1111', pattern: { template: 'require-option', callee: { level: 'declaration', key: 'src/http.ts#Deps.fetch' }, argIndex: 1, property: 'redirect' } });
        saveLearnedRule(cwd, { ...base, id: 'require-guard-cache-control-bbbb2222', pattern: { template: 'require-guard', callee: { level: 'text', key: 'Response.json' }, property: 'cache-control', guard: 'stepsAvailable', appliesWhenArgsMention: false, scope: { file: 'src/route.ts', fn: 'GET>respond' } } });

        const rules = loadStudioLearnedRules(cwd);
        expect(rules.map(r => [r.requirement, r.appliesTo])).toEqual([
            ['`cache-control` conditional on `stepsAvailable`', 'regression guard for GET>respond in src/route.ts'],
            ['`redirect` in argument 2', 'declaration src/http.ts#Deps.fetch'],
        ]);
        expect(rules[1].validation.repoHits).toEqual(['src/other.ts:4']);
    });

    it('is empty for a repository without learned rules', () => {
        cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-learned-'));
        expect(loadStudioLearnedRules(cwd)).toEqual([]);
    });
});
