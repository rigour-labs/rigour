import fs from 'fs';
import path from 'path';

/**
 * Resolve CLI version from local package.json at runtime.
 * Works for source and built dist paths.
 */
export function getCliVersion(fallback = '0.0.0'): string {
    try {
        const pkgPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../package.json');
        if (fs.existsSync(pkgPath)) {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version?: string };
            if (pkg.version && pkg.version.trim().length > 0) {
                return pkg.version;
            }
        }
    } catch {
        // Fall through to fallback.
    }
    return fallback;
}

