import { describe, it, expect } from 'vitest';
import { TOOL_GROUPS, advertisedToolNames, getAdvertisedToolDefinitions } from './advertised-tools.js';
import { TOOL_DEFINITIONS } from './tools/definitions.js';

describe('advertised MCP tools', () => {
    it('advertises the core loop by default, including review before done', () => {
        const names = advertisedToolNames(undefined);
        expect([...names].sort()).toEqual([...TOOL_GROUPS.core].sort());
        expect(names.has('rigour_review')).toBe(true);
        expect(names.has('rigour_checkpoint')).toBe(false);
    });

    it('adds groups on request, keeps core, ignores unknown groups, and "full" lists them all', () => {
        const names = advertisedToolNames('governance, telemetry, nonsense');
        expect(names.has('rigour_checkpoint') && names.has('rigour_task_cost') && names.has('rigour_review')).toBe(true);
        expect(names.has('rigour_security_audit')).toBe(false);
        expect(advertisedToolNames('full').size).toBe(Object.values(TOOL_GROUPS).flat().length);
    });

    it('only groups tools that exist and have a definition', () => {
        const defined = new Set(TOOL_DEFINITIONS.map(t => t.name));
        for (const name of Object.values(TOOL_GROUPS).flat()) expect(defined.has(name)).toBe(true);
    });

    it('keeps the default tool definitions small', () => {
        const core = JSON.stringify(getAdvertisedToolDefinitions('')).length;
        const everything = JSON.stringify(getAdvertisedToolDefinitions('full')).length;
        expect(core).toBeLessThan(everything / 2);
    });

    it('does not advertise obsolete power-user settings tools in any group', () => {
        const all = advertisedToolNames('full');
        for (const toolName of ['rigour_mcp_get_settings', 'rigour_mcp_set_settings', 'rigour_status']) {
            expect(all.has(toolName)).toBe(false);
        }
    });
});
