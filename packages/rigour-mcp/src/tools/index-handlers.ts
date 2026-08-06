/**
 * Pattern Index MCP Tool Handler
 *
 * Wraps PatternIndexer for agent-accessible index build/update.
 */
import path from 'path';
import {
    PatternIndexer,
    savePatternIndex,
    loadPatternIndex,
    getDefaultIndexPath,
    type PatternIndex,
    type PatternEntry,
} from '@rigour-labs/core/pattern-index';
import {
    setStaticCache,
    setComponentCache,
    type ComponentDossier,
} from '@rigour-labs/core';
import { notifyProgress } from '../utils/notifications.js';
import { buildTelemetryMeta, getWorkspaceCommitSha, type ToolResult } from '../utils/context-telemetry.js';
import { appendContextFooter } from '../utils/context-footer.js';
import fs from 'fs-extra';

async function syncIndexToCache(cwd: string, index: PatternIndex): Promise<void> {
    const commitSha = await getWorkspaceCommitSha(cwd);
    const repo = path.basename(cwd);

    const byFile = new Map<string, PatternEntry[]>();
    for (const pattern of index.patterns) {
        const list = byFile.get(pattern.file) ?? [];
        list.push(pattern);
        byFile.set(pattern.file, list);
    }

    for (const [filePath, patterns] of byFile) {
        const absPath = path.join(cwd, filePath);
        let content = '';
        try {
            if (await fs.pathExists(absPath)) {
                content = await fs.readFile(absPath, 'utf-8');
            }
        } catch {
            content = patterns.map(p => p.signature ?? p.name).join('\n');
        }

        await setStaticCache(repo, 'main', filePath, content || filePath, {
            exports: patterns.map(p => p.name),
            rigourPatterns: patterns.map(p => `${p.type}:${p.name}`),
            ownership: path.dirname(filePath),
        }, cwd);

        const componentName = path.dirname(filePath) || filePath;
        const dossier: ComponentDossier = {
            component: componentName,
            responsibility: `Indexed patterns in ${filePath}`,
            canonicalFiles: [filePath],
            contracts: patterns.filter(p => p.type === 'interface' || p.type === 'type').map(p => p.name),
            directConsumers: [],
            validationCommands: [],
        };
        await setComponentCache(componentName, commitSha, dossier, `index-${index.lastUpdated}`, '3', cwd);
    }
}

export async function handleIndex(
    cwd: string,
    options: { semantic?: boolean; force?: boolean; output?: string } = {},
): Promise<ToolResult> {
    const indexPath = options.output || getDefaultIndexPath(cwd);
    const candidateEstimate = 'Full codebase AST scan for pattern extraction';

    try {
        notifyProgress('info', 'Building pattern index...');

        const indexer = new PatternIndexer(cwd, { useEmbeddings: options.semantic ?? false });
        const existingIndex = await loadPatternIndex(indexPath);

        let index: PatternIndex;
        if (existingIndex && !options.force) {
            index = await indexer.updateIndex(existingIndex);
        } else {
            index = await indexer.buildIndex();
        }

        await savePatternIndex(index, indexPath);
        await syncIndexToCache(cwd, index);

        notifyProgress('info', 'Pattern index complete');

        const byType = Object.entries(index.stats.byType)
            .map(([type, count]) => `${type}: ${count}`)
            .join(', ');

        let text = `✅ PATTERN INDEX ${options.force ? 'REBUILT' : 'UPDATED'}\n\n`;
        text += `- Total Patterns: ${index.stats.totalPatterns}\n`;
        text += `- Total Files: ${index.stats.totalFiles}\n`;
        text += `- Index Path: ${indexPath}\n`;
        text += `- Duration: ${index.stats.indexDurationMs}ms\n`;
        if (options.semantic) text += `- Semantic Search: Enabled\n`;
        text += `- Types: ${byType}\n\n`;
        text += `Index synced to context cache layers. Use rigour_context_scope before reading files.`;

        const telemetry = buildTelemetryMeta({
            candidateText: candidateEstimate,
            returnedText: text,
            cacheStatus: 'miss',
        });

        return {
            content: [{ type: 'text', text: appendContextFooter(text, telemetry, 'rigour_context_scope("your task")') }],
            _telemetry: telemetry,
        };
    } catch (error: any) {
        return {
            content: [{ type: 'text', text: `RIGOUR ERROR: Failed to build pattern index: ${error.message}` }],
            isError: true,
        };
    }
}
