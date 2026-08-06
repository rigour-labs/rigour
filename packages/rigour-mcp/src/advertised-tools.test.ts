import { describe, it, expect } from 'vitest';
import {
    ADVERTISED_TOOLS,
    GOVERNANCE_TOOLS,
    getAdvertisedToolDefinitions,
} from './advertised-tools.js';
import { TOOL_DEFINITIONS } from './tools/definitions.js';

describe('advertised MCP tools', () => {
    it('includes governance tools with dispatch handlers', () => {
        for (const toolName of GOVERNANCE_TOOLS) {
            expect(ADVERTISED_TOOLS.has(toolName)).toBe(true);
            expect(TOOL_DEFINITIONS.some(t => t.name === toolName)).toBe(true);
        }
    });

    it('lists only intentional advertised tools', () => {
        const advertised = getAdvertisedToolDefinitions();
        expect(advertised.length).toBe(ADVERTISED_TOOLS.size);
        for (const tool of advertised) {
            expect(ADVERTISED_TOOLS.has(tool.name)).toBe(true);
        }
    });

    it('does not advertise obsolete power-user settings tools', () => {
        const hidden = ['rigour_mcp_get_settings', 'rigour_mcp_set_settings', 'rigour_status'];
        for (const toolName of hidden) {
            expect(ADVERTISED_TOOLS.has(toolName)).toBe(false);
        }
    });
});
