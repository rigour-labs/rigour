import fs from 'fs';

export interface ExecutableCheckResult {
    ok: boolean;
    fixed: boolean;
}

export function isExecutableBinary(binaryPath: string, platform = process.platform): boolean {
    if (platform === 'win32') {
        return fs.existsSync(binaryPath);
    }

    try {
        fs.accessSync(binaryPath, fs.constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

export function ensureExecutableBinary(binaryPath: string, platform = process.platform): ExecutableCheckResult {
    if (platform === 'win32') {
        return { ok: fs.existsSync(binaryPath), fixed: false };
    }

    if (isExecutableBinary(binaryPath, platform)) {
        return { ok: true, fixed: false };
    }

    try {
        fs.chmodSync(binaryPath, 0o755);
    } catch {
        return { ok: false, fixed: false };
    }

    const ok = isExecutableBinary(binaryPath, platform);
    return { ok, fixed: ok };
}
