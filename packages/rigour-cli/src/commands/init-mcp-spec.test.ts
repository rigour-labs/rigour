import { describe, expect, it } from 'vitest';
import { mcpPackageSpec } from './init.js';

describe('mcpPackageSpec', () => {
    it("pins the MCP server to this CLI's exact version, as the hooks pin the CLI, never a bare name", () => {
        expect(mcpPackageSpec('6.13.0')).toBe('@rigour-labs/mcp@6.13.0');
        expect(mcpPackageSpec('6.13.0-rc.5')).toBe('@rigour-labs/mcp@6.13.0-rc.5');
        expect(mcpPackageSpec('0.0.0')).toBe('@rigour-labs/mcp@latest');
        expect(mcpPackageSpec('unknown')).toBe('@rigour-labs/mcp@latest');
    });
});
