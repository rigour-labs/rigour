import { existsSync, readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

/**
 * Resolve MCP package version from local package.json at runtime.
 * Works for source and built dist paths.
 */
export function getMcpVersion(fallback = "0.0.0"): string {
    try {
        const modulePath = fileURLToPath(import.meta.url);
        const pkgPath = resolve(dirname(modulePath), "../../package.json");
        if (existsSync(pkgPath)) {
            const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: string };
            if (pkg.version && pkg.version.trim().length > 0) {
                return pkg.version;
            }
        }
    } catch {
        // Fall through to fallback.
    }
    return fallback;
}
