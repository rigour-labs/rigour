import fs from 'fs';
import os from 'os';
import path from 'path';
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

    it("lists the governance tools when the repository's rigour.yml turns on agent teams or checkpoints", () => {
        const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-governance-'));
        const names = () => getAdvertisedToolDefinitions(undefined, repo).map(t => t.name);
        expect(names()).not.toContain('rigour_checkpoint');
        fs.writeFileSync(path.join(repo, 'rigour.yml'), 'version: 1\ngates:\n  checkpoint:\n    enabled: true\n');
        expect(names()).toEqual(expect.arrayContaining(['rigour_checkpoint', 'rigour_agent_register']));
        fs.rmSync(repo, { recursive: true, force: true });
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
