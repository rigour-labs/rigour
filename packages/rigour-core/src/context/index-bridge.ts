/**
 * Bridge between Pattern Index and 4-Layer Context Cache.
 * Syncs indexed patterns into static cache entries and component dossiers.
 */

import fs from 'fs-extra';
import path from 'path';
import type { PatternIndex, PatternEntry } from '../pattern-index/types.js';
import { setStaticCache, setComponentCache, hashContent } from './cache-engine.js';

function getIndexPath(cwd: string): string {
    return path.join(cwd, '.rigour', 'patterns.json');
}

export interface IndexHealthReport {
    indexPath: string;
    exists: boolean;
    lastUpdated?: string;
    ageMs?: number;
    isStale: boolean;
    staleThresholdMs: number;
    totalPatterns?: number;
    totalFiles?: number;
    message: string;
}

const DEFAULT_STALE_MS = 24 * 60 * 60 * 1000;

function groupByComponent(patterns: PatternEntry[]): Map<string, PatternEntry[]> {
    const groups = new Map<string, PatternEntry[]>();
    for (const p of patterns) {
        const key = p.type === 'component' ? p.name : p.category || 'uncategorized';
        const list = groups.get(key) ?? [];
        list.push(p);
        groups.set(key, list);
    }
    return groups;
}

function buildDossier(component: string, patterns: PatternEntry[]): {
    component: string;
    responsibility: string;
    canonicalFiles: string[];
    contracts: string[];
    directConsumers: string[];
    validationCommands: string[];
} {
    const canonicalFiles = [...new Set(patterns.map(p => p.file))];
    const contracts = patterns
        .filter(p => p.signature)
        .map(p => p.signature)
        .slice(0, 20);
    const descriptions = patterns.map(p => p.description).filter(Boolean);
    const responsibility = descriptions[0] || `Indexed ${patterns.length} patterns for ${component}`;

    return {
        component,
        responsibility,
        canonicalFiles,
        contracts,
        directConsumers: [],
        validationCommands: [],
    };
}

/**
 * Sync pattern index entries into static cache and component dossier layers.
 */
export async function syncIndexToContextCache(cwd: string, index: PatternIndex): Promise<number> {
    const resolved = path.resolve(cwd);
    const repo = path.basename(index.rootDir || resolved);
    const branch = 'main';
    const commitSha = hashContent(index.lastUpdated);
    let synced = 0;

    for (const file of index.files) {
        const filePatterns = index.patterns.filter(p => p.file === file.path);
        if (filePatterns.length === 0) continue;

        const payload = {
            rigourPatterns: filePatterns.map(p => `${p.type}:${p.name}`),
            exports: filePatterns.filter(p => p.exported).map(p => p.name),
        };
        const fileContent = JSON.stringify(payload);
        await setStaticCache(repo, branch, file.path, fileContent, payload, resolved);
        synced++;
    }

    const componentGroups = groupByComponent(index.patterns);
    for (const [component, patterns] of componentGroups) {
        const dossier = buildDossier(component, patterns);
        const fingerprint = hashContent(JSON.stringify(patterns.map(p => p.id)));
        await setComponentCache(component, commitSha, dossier, fingerprint, '3', resolved);
        synced++;
    }

    return synced;
}

/**
 * Check patterns.json freshness relative to the project directory.
 */
export async function getIndexHealth(cwd: string, staleThresholdMs = DEFAULT_STALE_MS): Promise<IndexHealthReport> {
    const resolved = path.resolve(cwd);
    const indexPath = getIndexPath(resolved);

    if (!await fs.pathExists(indexPath)) {
        return {
            indexPath,
            exists: false,
            isStale: true,
            staleThresholdMs,
            message: 'patterns.json not found — run pattern index build',
        };
    }

    const stat = await fs.stat(indexPath);
    const ageMs = Date.now() - stat.mtimeMs;
    let index: PatternIndex | null = null;

    try {
        index = await fs.readJson(indexPath) as PatternIndex;
    } catch {
        return {
            indexPath,
            exists: true,
            ageMs,
            isStale: true,
            staleThresholdMs,
            message: 'patterns.json is malformed',
        };
    }

    const isStale = ageMs > staleThresholdMs;
    return {
        indexPath,
        exists: true,
        lastUpdated: index.lastUpdated,
        ageMs,
        isStale,
        staleThresholdMs,
        totalPatterns: index.stats?.totalPatterns,
        totalFiles: index.stats?.totalFiles,
        message: isStale
            ? `Index is stale (${Math.round(ageMs / 3600000)}h old)`
            : 'Index is fresh',
    };
}
