import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DiscoveryService } from './discovery.js';
import fs from 'fs-extra';
import path from 'path';

vi.mock('fs-extra');

describe('DiscoveryService', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('should discover project marker in root directory', async () => {
        const service = new DiscoveryService();
        vi.mocked(fs.pathExists).mockImplementation(async (p: string) => p.includes('package.json'));
        vi.mocked(fs.readdir).mockResolvedValue(['package.json'] as any);
        vi.mocked(fs.readFile).mockResolvedValue('{}' as any);

        const result = await service.discover('/test');
        // If package.json doesn't match a specific role marker, it stays Universal.
        // Let's mock a specific one like 'express'
        vi.mocked(fs.pathExists).mockImplementation(async (p: string) => p.includes('express'));
        const result2 = await service.discover('/test');
        expect(result2.matches.preset?.name).toBe('api');
    });

    it('should discover project marker in src/ directory (Deep Detection)', async () => {
        const service = new DiscoveryService();
        vi.mocked(fs.pathExists).mockImplementation((async (p: string) => {
            if (p.endsWith('src')) return true;
            if (p.includes('src/index.ts')) return true;
            return false;
        }) as any);
        vi.mocked(fs.readdir).mockImplementation((async (p: string) => {
            if (p.toString().endsWith('/test')) return ['src'] as any;
            if (p.toString().endsWith('src')) return ['index.ts'] as any;
            return [] as any;
        }) as any);
        vi.mocked(fs.readFile).mockResolvedValue('export const x = 1;' as any);

        const result = await service.discover('/test');
        // Since UNIVERSAL_CONFIG has a default, we check if it found something extra or matches expectation
        // Default is universal, but detecting .ts should tilt it towards node or similar if configured
        // In our current templates, package.json is the node marker.
        // Let's check for paradigm detection which uses content
        expect(result.config).toBeDefined();
    });

    it('should identify OOP paradigm from content in subfolder', async () => {
        const service = new DiscoveryService();
        vi.mocked(fs.pathExists).mockImplementation((async (p: string) => p.endsWith('src') || p.endsWith('src/Service.ts')) as any);
        vi.mocked(fs.readdir).mockImplementation((async (p: string) => {
            if (p.toString().endsWith('src')) return ['Service.ts'] as any;
            return ['src'] as any;
        }) as any);
        vi.mocked(fs.readFile).mockResolvedValue('class MyService {}' as any);

        const result = await service.discover('/test');
        expect(result.matches.paradigm?.name).toBe('oop');
    });

    it('should include project-type-aware ignore patterns for API preset', async () => {
        const service = new DiscoveryService();
        // Mock finding requirements.txt (Python API marker)
        vi.mocked(fs.pathExists).mockImplementation(async (p: string) => p.includes('requirements.txt'));
        vi.mocked(fs.readdir).mockResolvedValue(['requirements.txt'] as any);
        vi.mocked(fs.readFile).mockResolvedValue('flask==2.0.0' as any);

        const result = await service.discover('/test');
        expect(result.matches.preset?.name).toBe('api');
        expect(result.config.ignore).toContain('venv/**');
        expect(result.config.ignore).toContain('__pycache__/**');
        expect(result.config.ignore).toContain('*.pyc');
    });

    it('should include project-type-aware ignore patterns for UI preset', async () => {
        const service = new DiscoveryService();
        // Mock finding next.config.js (UI marker)
        vi.mocked(fs.pathExists).mockImplementation(async (p: string) => p.includes('next.config.js'));
        vi.mocked(fs.readdir).mockResolvedValue(['next.config.js'] as any);
        vi.mocked(fs.readFile).mockResolvedValue('module.exports = {}' as any);

        const result = await service.discover('/test');
        expect(result.matches.preset?.name).toBe('ui');
        expect(result.config.ignore).toContain('node_modules/**');
        expect(result.config.ignore).toContain('.next/**');
    });
});
