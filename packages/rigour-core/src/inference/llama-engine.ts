/**
 * llama.cpp engine: install from the pinned GitHub release and verify that a
 * candidate binary actually runs.
 *
 * The release archives link llama-cli against shared libraries next to it
 * (@rpath → @loader_path on macOS), so the whole bin folder is installed; a
 * lone llama-cli fails with "Library not loaded: @rpath/libllama.dylib".
 */
import os from 'os';
import path from 'path';
import fs from 'fs-extra';
import { RIGOUR_DIR } from '../storage/db.js';
import { downloadToFile, type HttpGet } from './http-download.js';
import { runProcess } from './llama-process.js';

export const LLAMA_RELEASE_TAG = 'b5604';
const LLAMA_RELEASE_BASE = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_RELEASE_TAG}`;
const PROBE_TIMEOUT_MS = 5_000;
const EXTRACT_TIMEOUT_MS = 120_000;

/**
 * Platform → llama.cpp release asset and its SHA-256, checked against the digest GitHub publishes
 * for the release. A download that does not match is refused: the engine runs code on the
 * user's machine. linux-arm64 has no published build.
 */
const LLAMA_RELEASE_ASSETS: Record<string, { file: string; sha256: string }> = {
    'darwin-arm64': { file: `llama-${LLAMA_RELEASE_TAG}-bin-macos-arm64.zip`, sha256: '673c5f8c4a7a2226ca6f3db5141d1ed78dcdf178d902c1486b77b3dda41e6a61' },
    'darwin-x64': { file: `llama-${LLAMA_RELEASE_TAG}-bin-macos-x64.zip`, sha256: 'ab9ba59f3e355aebe6bc2c632b3489d4ab98d727f0ee03b9df6b4a6207452ad2' },
    'linux-x64': { file: `llama-${LLAMA_RELEASE_TAG}-bin-ubuntu-x64.zip`, sha256: '3981c1e353399fbc35ea23316854b3c302877c00fb6b7fa4063a0623ad9e0309' },
    'win32-x64': { file: `llama-${LLAMA_RELEASE_TAG}-bin-win-cpu-x64.zip`, sha256: 'df32d58de0b57c3c9de2e68e44b947efbac1b8a3e417536b6703cbd8da11eddd' },
};

export function llamaBinaryName(): string {
    return os.platform() === 'win32' ? 'llama-cli.exe' : 'llama-cli';
}

/** Install directory for the pinned release: ~/.rigour/bin/llama-<tag>. */
export function managedEngineDir(): string {
    return path.join(RIGOUR_DIR, 'bin', `llama-${LLAMA_RELEASE_TAG}`);
}

export function managedEnginePath(): string {
    return path.join(managedEngineDir(), llamaBinaryName());
}

export function releaseAssetFor(platformKey: string): { file: string; sha256: string } | undefined {
    return LLAMA_RELEASE_ASSETS[platformKey];
}

export interface ProbeResult {
    ok: boolean;
    version?: string;
    error?: string;
}

const probeCache = new Map<string, Promise<ProbeResult>>();

/**
 * Run `<binary> --version` and accept it only if it exits 0. A placeholder
 * script (such as an unbundled brain package) or a binary missing its shared
 * libraries fails here instead of on every inference call.
 */
export function probeBinary(binaryPath: string): Promise<ProbeResult> {
    let cached = probeCache.get(binaryPath);
    if (!cached) {
        cached = runProbe(binaryPath);
        probeCache.set(binaryPath, cached);
    }
    return cached;
}

/** Forget cached probe results, e.g. after installing a new engine. */
export function resetProbeCache(): void {
    probeCache.clear();
}

async function runProbe(binaryPath: string): Promise<ProbeResult> {
    if (!(await fs.pathExists(binaryPath))) return { ok: false, error: 'not found' };
    try {
        const { code, stdout, stderr } = await runProcess(binaryPath, ['--version'], { timeoutMs: PROBE_TIMEOUT_MS });
        const output = `${stdout}\n${stderr}`;
        if (code !== 0) return { ok: false, error: lastLine(output) || `exit code ${code}` };
        const version = output.match(/version:\s*([^\s]+)/)?.[1];
        return { ok: true, version };
    } catch (error: any) {
        return { ok: false, error: error?.message ?? String(error) };
    }
}

function lastLine(text: string): string {
    return text.trim().split(/\r?\n/).pop()?.trim() ?? '';
}

/**
 * Download the pinned release for this platform and install its whole bin
 * folder into managedEngineDir(). Returns the verified binary path.
 */
export async function installLlamaEngine(
    onProgress?: (message: string) => void,
    get?: HttpGet,
): Promise<string> {
    const platformKey = `${os.platform()}-${os.arch()}`;
    const asset = releaseAssetFor(platformKey);
    if (!asset) {
        throw new Error(`No llama.cpp ${LLAMA_RELEASE_TAG} build is published for ${platformKey}. Install llama-cli on PATH or use a cloud provider.`);
    }

    const installDir = managedEngineDir();
    const workDir = `${installDir}.partial`;
    const zipPath = path.join(path.dirname(installDir), asset.file);
    await fs.ensureDir(path.dirname(installDir));
    await fs.remove(workDir);

    onProgress?.(`⬇ Downloading inference engine (llama.cpp ${LLAMA_RELEASE_TAG})...`);
    try {
        const { sha256 } = await downloadToFile(`${LLAMA_RELEASE_BASE}/${asset.file}`, zipPath, { get });
        if (sha256 !== asset.sha256) {
            throw new Error(`llama.cpp ${asset.file} does not match its pinned checksum (got ${sha256.slice(0, 12)}…, expected ${asset.sha256.slice(0, 12)}…); not installing it.`);
        }
        onProgress?.('  Verified checksum. Extracting...');
        await extractZip(zipPath, workDir);
        await installBinFolder(workDir, installDir);
    } finally {
        await fs.remove(zipPath).catch(() => undefined);
        await fs.remove(workDir).catch(() => undefined);
    }

    resetProbeCache();
    const binary = managedEnginePath();
    const probe = await probeBinary(binary);
    if (!probe.ok) {
        throw new Error(`Installed llama-cli does not run: ${probe.error}`);
    }
    onProgress?.(`✓ Inference engine ready (llama.cpp ${probe.version ?? LLAMA_RELEASE_TAG})`);
    return binary;
}

async function extractZip(zipPath: string, destDir: string): Promise<void> {
    await fs.ensureDir(destDir);
    const result = os.platform() === 'win32'
        ? await runProcess('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath ${psQuote(zipPath)} -DestinationPath ${psQuote(destDir)} -Force`], { timeoutMs: EXTRACT_TIMEOUT_MS })
        : await runProcess('unzip', ['-q', '-o', zipPath, '-d', destDir], { timeoutMs: EXTRACT_TIMEOUT_MS });
    if (result.code !== 0) {
        throw new Error(`Could not extract ${path.basename(zipPath)}: ${lastLine(result.stderr) || `exit code ${result.code}`}`);
    }
}

/** PowerShell single-quoted literal: a quote inside is escaped by doubling it. */
function psQuote(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

/** Copy the folder that contains llama-cli (binary + shared libraries) into place. */
export async function installBinFolder(extractedRoot: string, installDir: string): Promise<void> {
    const binary = await findFileRecursive(extractedRoot, llamaBinaryName());
    if (!binary) throw new Error(`${llamaBinaryName()} not found in the llama.cpp release archive`);

    await fs.remove(installDir);
    await fs.copy(path.dirname(binary), installDir);
    if (os.platform() !== 'win32') {
        await fs.chmod(path.join(installDir, llamaBinaryName()), 0o755);
    }
}

/** Release archives nest the binary at most a few folders deep (build/bin/). */
const MAX_ARCHIVE_DEPTH = 6;

async function findFileRecursive(dir: string, filename: string, depth = 0): Promise<string | null> {
    if (depth > MAX_ARCHIVE_DEPTH) return null;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            const found = await findFileRecursive(fullPath, filename, depth + 1);
            if (found) return found;
        } else if (entry.name === filename) {
            return fullPath;
        }
    }
    return null;
}
