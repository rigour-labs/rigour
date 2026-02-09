import fs from 'fs-extra';
import path from 'path';
import os from 'os';

const CACHE_FILE = path.join(os.homedir(), '.rigour-version-cache.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const NPM_REGISTRY_URL = 'https://registry.npmjs.org/@rigour-labs/cli/latest';

interface VersionCache {
    latestVersion: string;
    timestamp: number;
}

interface UpdateCheckResult {
    hasUpdate: boolean;
    currentVersion: string;
    latestVersion: string;
}

async function getCachedVersion(): Promise<string | null> {
    try {
        if (await fs.pathExists(CACHE_FILE)) {
            const cache: VersionCache = await fs.readJson(CACHE_FILE);
            if (Date.now() - cache.timestamp < CACHE_TTL_MS) {
                return cache.latestVersion;
            }
        }
    } catch {
        // Ignore cache read errors
    }
    return null;
}

async function cacheVersion(version: string): Promise<void> {
    try {
        await fs.writeJson(CACHE_FILE, {
            latestVersion: version,
            timestamp: Date.now()
        } satisfies VersionCache);
    } catch {
        // Ignore cache write errors
    }
}

async function fetchLatestVersion(): Promise<string | null> {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);

        const response = await fetch(NPM_REGISTRY_URL, {
            signal: controller.signal,
            headers: { 'Accept': 'application/json' }
        });

        clearTimeout(timeout);

        if (!response.ok) return null;

        const data = await response.json() as { version?: string };
        return data.version || null;
    } catch {
        // Network errors are non-fatal
        return null;
    }
}

function compareVersions(current: string, latest: string): boolean {
    const currentParts = current.replace(/^v/, '').split('.').map(Number);
    const latestParts = latest.replace(/^v/, '').split('.').map(Number);

    for (let i = 0; i < 3; i++) {
        const c = currentParts[i] || 0;
        const l = latestParts[i] || 0;
        if (l > c) return true;
        if (l < c) return false;
    }
    return false;
}

export async function checkForUpdates(currentVersion: string): Promise<UpdateCheckResult | null> {
    // Try cache first
    let latestVersion = await getCachedVersion();

    // Fetch from npm if no cache
    if (!latestVersion) {
        latestVersion = await fetchLatestVersion();
        if (latestVersion) {
            await cacheVersion(latestVersion);
        }
    }

    if (!latestVersion) return null;

    return {
        hasUpdate: compareVersions(currentVersion, latestVersion),
        currentVersion,
        latestVersion
    };
}
