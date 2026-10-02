import { describe, it, expect, beforeEach, vi } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs-extra';

vi.mock('./db.js', () => ({
    isSQLiteAvailable: () => false,
    openDatabase: async () => null,
    DB_PATH: '/tmp/rigour-test.db',
    RIGOUR_DIR: '/tmp/.rigour',
}));

import {
    getSemanticQueryCache,
    setSemanticQueryCache,
    findRelatedSemanticQueryCache,
    queryTokenOverlap,
    distinctiveTokenAgreement,
    filterExistingEditScope,
    getTaskCheckpointCache,
    setTaskCheckpointCache,
    hashContent,
    normalizeQuery
} from './cache-engine.js';

describe('Context cache engine', () => {
    const testCwd = path.join(os.tmpdir(), `rigour-cache-test-${Date.now()}`);

    beforeEach(async () => {
        await fs.ensureDir(testCwd);
    });

    it('should calculate consistent SHA-256 hashes', () => {
        const hash1 = hashContent('const x = 1;');
        const hash2 = hashContent('const x = 1;');
        const hash3 = hashContent('const x = 2;');

        expect(hash1).toBe(hash2);
        expect(hash1).not.toBe(hash3);
        expect(hash1.length).toBe(16);
    });

    it('should normalize intent queries correctly', () => {
        expect(normalizeQuery('  Add priority to task!! ')).toBe('add priority to task');
        expect(normalizeQuery('Task SHOULD Support Priority.')).toBe('task should support priority');
    });

    it('Layer 3: should store and retrieve semantic query scope', async () => {
        const entry = {
            query: 'task priority persistence',
            resolvedOwner: 'task-team',
            editScope: ['services/task.ts'],
            validationScope: ['npm test'],
            evidence: ['AST match'],
            commitSha: 'commit-99',
            confidence: 0.95
        };

        await setSemanticQueryCache('add priority to task', 'commit-99', entry, testCwd);
        const retrieved = await getSemanticQueryCache('add priority to task', 'commit-99', testCwd);

        expect(retrieved).not.toBeNull();
        expect(retrieved?.resolvedOwner).toBe('task-team');
        expect(retrieved?.editScope).toContain('services/task.ts');
    });

    it('Layer 4: should store and retrieve subagent task checkpoint packet', async () => {
        const packet = {
            taskId: 'CTP-142',
            agentId: 'CTP-142-task',
            phase: 'implementation',
            component: 'services/task',
            changedFiles: ['services/task.ts'],
            decisions: ['Added priority field'],
            validation: ['npm test passed'],
            remainingWork: ['Add integration test'],
            risks: ['Migration needed']
        };

        await setTaskCheckpointCache(packet, 126000, testCwd);
        const retrieved = await getTaskCheckpointCache('CTP-142', 'CTP-142-task', 'implementation', testCwd);

        expect(retrieved).not.toBeNull();
        expect(retrieved?.taskId).toBe('CTP-142');
        expect(retrieved?.decisions).toContain('Added priority field');
    });

    it('Layer 3: finds related semantic queries at same commit for partial reuse', async () => {
        expect(
            queryTokenOverlap('task priority persistence service', 'task priority persistence service layer'),
        ).toBeGreaterThan(0.7);
        expect(distinctiveTokenAgreement('task service', 'payment service')).toBeLessThan(0.67);

        await setSemanticQueryCache(
            'task priority persistence service',
            'commit-rel',
            {
                query: 'task priority persistence service',
                resolvedOwner: 'task-team',
                editScope: ['services/task.ts'],
                validationScope: ['npm test'],
                evidence: ['related'],
                commitSha: 'commit-rel',
                confidence: 0.9,
            },
            testCwd,
        );

        const related = await findRelatedSemanticQueryCache(
            'task priority persistence service layer',
            'commit-rel',
            testCwd,
        );
        expect(related).not.toBeNull();
        expect(related?.entry.editScope).toContain('services/task.ts');

        // Same generic stem, different distinctive noun → reject
        await setSemanticQueryCache(
            'payment service billing',
            'commit-rel',
            {
                query: 'payment service billing',
                resolvedOwner: 'pay',
                editScope: ['services/pay.ts'],
                validationScope: [],
                evidence: [],
                commitSha: 'commit-rel',
                confidence: 0.9,
            },
            testCwd,
        );
        const crossDomain = await findRelatedSemanticQueryCache('task service billing', 'commit-rel', testCwd);
        expect(crossDomain).toBeNull();

        const otherCommit = await findRelatedSemanticQueryCache(
            'task priority persistence service layer',
            'commit-other',
            testCwd,
        );
        expect(otherCommit).toBeNull();
    });

    it('filters missing edit-scope files for quality', async () => {
        await fs.writeFile(path.join(testCwd, 'alive.ts'), 'export const ok = 1;\n');
        const result = await filterExistingEditScope(['alive.ts', 'gone.ts'], testCwd);
        expect(result.valid).toEqual(['alive.ts']);
        expect(result.missing).toEqual(['gone.ts']);
    });
});
