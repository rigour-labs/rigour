export function resolveStudioVersion(cliVersion: unknown, mcpVersion: unknown): string {
    if (typeof cliVersion === 'string' && cliVersion.trim()) return cliVersion.trim();
    if (typeof mcpVersion === 'string' && mcpVersion.trim()) return mcpVersion.trim();
    return '0.0.0';
}
