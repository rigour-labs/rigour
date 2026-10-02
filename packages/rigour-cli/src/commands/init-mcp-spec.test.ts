import { describe, expect, it } from 'vitest';
import { mcpPackageSpec } from './init.js';

describe('mcpPackageSpec', () => {
    it("pins the MCP server to this CLI's major, never a bare or stale exact version", () => {
        expect(mcpPackageSpec('6.5.2')).toBe('@rigour-labs/mcp@6');
        expect(mcpPackageSpec('7.0.0-beta.1')).toBe('@rigour-labs/mcp@7');
        expect(mcpPackageSpec('0.0.0')).toBe('@rigour-labs/mcp@latest');
        expect(mcpPackageSpec('unknown')).toBe('@rigour-labs/mcp@latest');
    });
});
