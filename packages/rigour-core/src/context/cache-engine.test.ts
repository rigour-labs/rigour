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
    getStaticCache,
    setStaticCache,
    getComponentCache,
    setComponentCache,
    getSemanticQueryCache,
    setSemanticQueryCache,
    findRelatedSemanticQueryCache,
    queryTokenOverlap,
    filterExistingEditScope,
    getTaskCheckpointCache,
    setTaskCheckpointCache,
    hashContent,
    normalizeQuery
} from './cache-engine.js';

describe('4-Layer Context Cache Engine', () => {
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

    it('Layer 1: should store and retrieve content-addressed static cache', async () => {
        const fileContent = 'export function processTask() { return true; }';
        const entry = {
            exports: ['processTask'],
            imports: [],
            ownership: 'platform-team',
            endpoints: ['/api/task']
        };

        await setStaticCache('rigour-repo', 'main', 'services/task.ts', fileContent, entry, testCwd);
        const cached = await getStaticCache('rigour-repo', 'main', 'services/task.ts', fileContent, testCwd);

        expect(cached).not.toBeNull();
        expect(cached?.exports).toEqual(['processTask']);
        expect(cached?.ownership).toBe('platform-team');
    });

    it('Layer 2: should store and retrieve component context dossier', async () => {
        const dossier = {
            component: 'services/task',
            responsibility: 'Task lifecycle and persistence',
            canonicalFiles: ['services/task.ts'],
            contracts: ['TaskContract'],
            directConsumers: ['controllers/task'],
            validationCommands: ['npm test']
        };

        await setComponentCache('services/task', 'abc123commit', dossier, 'dep-fingerprint-v1', '3', testCwd);
        const retrieved = await getComponentCache('services/task', 'abc123commit', '3', testCwd);

        expect(retrieved).not.toBeNull();
        expect(retrieved?.responsibility).toBe('Task lifecycle and persistence');
        expect(retrieved?.canonicalFiles).toContain('services/task.ts');
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
        expect(queryTokenOverlap('task priority persistence', 'priority for task persistence')).toBeGreaterThan(0.7);

        await setSemanticQueryCache(
            'task priority persistence',
            'commit-rel',
            {
                query: 'task priority persistence',
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
            'priority for task persistence layer',
            'commit-rel',
            testCwd,
            0.5,
        );
        expect(related).not.toBeNull();
        expect(related?.entry.editScope).toContain('services/task.ts');

        const otherCommit = await findRelatedSemanticQueryCache(
            'priority for task persistence layer',
            'commit-other',
            testCwd,
            0.5,
        );
        expect(otherCommit).toBeNull();
    });

    it('filters missing edit-scope files for quality', async () => {
        await fs.writeFile(path.join(testCwd, 'alive.ts'), 'export const ok = 1;\n');
        const result = await filterExistingEditScope(['alive.ts', 'gone.ts'], testCwd);
        expect(result.valid).toEqual(['alive.ts']);
        expect(result.missing).toEqual(['gone.ts']);
    });

    it('Layer 1: invalidates static cache when file content changes', async () => {
        const originalContent = 'export function processTask() { return true; }';
        const entry = {
            exports: ['processTask'],
            imports: [],
            ownership: 'platform-team',
            endpoints: ['/api/task'],
        };

        await setStaticCache('rigour-repo', 'main', 'services/task.ts', originalContent, entry, testCwd);
        const cached = await getStaticCache('rigour-repo', 'main', 'services/task.ts', originalContent, testCwd);
        expect(cached?.exports).toEqual(['processTask']);

        const changedContent = 'export function processTask() { return false; }';
        const stale = await getStaticCache('rigour-repo', 'main', 'services/task.ts', changedContent, testCwd);
        expect(stale).toBeNull();
    });
});
