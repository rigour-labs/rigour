/**
 * Pattern Index MCP Tool Handler
 *
 * Wraps PatternIndexer for agent-accessible index build/update.
 */
import {
    PatternIndexer,
    savePatternIndex,
    loadPatternIndex,
    getDefaultIndexPath,
    type PatternIndex,
} from '@rigour-labs/core/pattern-index';
import { recordIndexChoice } from '@rigour-labs/core';
import { notifyProgress } from '../utils/notifications.js';
import { buildTelemetryMeta, type ToolResult } from '../utils/context-telemetry.js';
import { appendContextFooter } from '../utils/context-footer.js';

export async function handleIndex(
    cwd: string,
    options: { semantic?: boolean; force?: boolean; output?: string } = {},
): Promise<ToolResult> {
    const indexPath = options.output || getDefaultIndexPath(cwd);
    const candidateEstimate = 'Full codebase AST scan for pattern extraction';

    try {
        notifyProgress('info', 'Building pattern index...');

        const semantic = options.semantic ?? true;
        const indexer = new PatternIndexer(cwd, { useEmbeddings: semantic });
        const existingIndex = await loadPatternIndex(indexPath);

        let index: PatternIndex;
        if (existingIndex && !options.force) {
            index = await indexer.updateIndex(existingIndex);
        } else {
            index = await indexer.buildIndex();
        }

        await savePatternIndex(index, indexPath);
        await recordIndexChoice(cwd, index, semantic);

        notifyProgress('info', 'Pattern index complete');

        const byType = Object.entries(index.stats.byType)
            .map(([type, count]) => `${type}: ${count}`)
            .join(', ');

        let text = `✅ PATTERN INDEX ${existingIndex && !options.force ? 'UPDATED' : 'BUILT'}\n\n`;
        text += `- Total Patterns: ${index.stats.totalPatterns}\n`;
        text += `- Total Files: ${index.stats.totalFiles}\n`;
        text += `- Index Path: ${indexPath}\n`;
        text += `- Duration: ${index.stats.indexDurationMs}ms\n`;
        text += `- Search by meaning: ${semantic ? (index.patterns.some(p => p.embedding?.length) ? 'on' : 'unavailable (local model did not load; name matching still works)') : 'off'}\n`;
        text += `- Types: ${byType}\n\n`;
        text += `Use rigour_context_scope before reading files.`;

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
