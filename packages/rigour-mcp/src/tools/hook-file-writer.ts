import fs from 'fs-extra';
import path from 'path';

interface HookFile {
    path: string;
    content: string;
    executable?: boolean;
}

function parseHookConfig(content: string, filePath: string): { hooks?: Record<string, unknown> } {
    try {
        return JSON.parse(content) as { hooks?: Record<string, unknown> };
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Cannot merge generated hook config ${filePath}: ${reason}`);
    }
}

export function mergeHookFiles(files: HookFile[]): HookFile[] {
    const merged = new Map<string, HookFile>();
    for (const file of files) {
        const existing = merged.get(file.path);
        if (!existing) {
            merged.set(file.path, file);
            continue;
        }
        const existingConfig = parseHookConfig(existing.content, file.path);
        const nextConfig = parseHookConfig(file.content, file.path);
        merged.set(file.path, {
            ...existing,
            content: JSON.stringify({
                ...existingConfig,
                ...nextConfig,
                hooks: { ...existingConfig.hooks, ...nextConfig.hooks },
            }, null, 2),
            executable: existing.executable || file.executable,
        });
    }
    return [...merged.values()];
}

export interface HookWriteResult {
    written: string[];
    skipped: string[];
    incompatible: string[];
}

export async function writeHookFiles(
    cwd: string,
    files: HookFile[],
    force: boolean,
): Promise<HookWriteResult> {
    const result: HookWriteResult = { written: [], skipped: [], incompatible: [] };
    for (const file of files) {
        const fullPath = path.join(cwd, file.path);
        if (!force && await fs.pathExists(fullPath)) {
            result.skipped.push(file.path);
            continue;
        }
        try {
            await fs.ensureDir(path.dirname(fullPath));
            await fs.writeFile(fullPath, file.content);
            if (file.executable) await fs.chmod(fullPath, 0o755);
            result.written.push(file.path);
        } catch (error) {
            const code = error instanceof Error && 'code' in error
                ? String((error as NodeJS.ErrnoException).code)
                : '';
            if (code !== 'ENOTDIR' && code !== 'EEXIST') throw error;
            result.incompatible.push(file.path);
        }
    }
    return result;
}

export function formatHookWriteResult(result: HookWriteResult): string[] {
    const parts: string[] = [];
    if (result.written.length > 0) parts.push(`✓ Created: ${result.written.join(', ')}`);
    if (result.skipped.length > 0) {
        parts.push(`⊘ Skipped (exists): ${result.skipped.join(', ')}. Use force=true to overwrite.`);
    }
    if (result.incompatible.length > 0) {
        parts.push(`⚠ Not configured (parent path is a file): ${result.incompatible.join(', ')}`);
    }
    return parts;
}
