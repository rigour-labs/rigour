/**
 * Sidecar Binary Provider — runs inference via pre-compiled llama.cpp binary.
 * Auto-downloads llama-cli from GitHub releases on first use.
 * Falls back to npm packages or PATH lookup for development/manual installs.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import os from 'os';
import fs from 'fs-extra';
import { createRequire } from 'module';
import type { InferenceProvider, InferenceOptions, ModelTier } from './types.js';
import { ensureModel, getModelPath, isModelCached, getModelInfo } from './model-manager.js';
import { ensureExecutableBinary } from './executable.js';

const execFileAsync = promisify(execFile);
const SIDECAR_INSTALL_DIR = path.join(os.homedir(), '.rigour', 'sidecar');
const BINARY_DIR = path.join(os.homedir(), '.rigour', 'bin');

/** Platform → npm package mapping (legacy, still checked) */
const PLATFORM_PACKAGES: Record<string, string> = {
    'darwin-arm64': '@rigour-labs/brain-darwin-arm64',
    'darwin-x64': '@rigour-labs/brain-darwin-x64',
    'linux-x64': '@rigour-labs/brain-linux-x64',
    'linux-arm64': '@rigour-labs/brain-linux-arm64',
    'win32-x64': '@rigour-labs/brain-win-x64',
};

const LLAMA_RELEASE_TAG = 'b5604';
const LLAMA_RELEASE_BASE = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_RELEASE_TAG}`;

/** Platform → llama.cpp release asset name */
const LLAMA_RELEASE_ASSETS: Record<string, string> = {
    'darwin-arm64': `llama-${LLAMA_RELEASE_TAG}-bin-macos-arm64.zip`,
    'darwin-x64': `llama-${LLAMA_RELEASE_TAG}-bin-macos-x64.zip`,
    'linux-x64': `llama-${LLAMA_RELEASE_TAG}-bin-ubuntu-x64.zip`,
    'win32-x64': `llama-${LLAMA_RELEASE_TAG}-bin-win-cpu-x64.zip`,
    // linux-arm64 not published by llama.cpp — users must build from source or use cloud provider
};

export class SidecarProvider implements InferenceProvider {
    readonly name = 'sidecar';
    private binaryPath: string | null = null;
    private modelPath: string | null = null;
    private tier: ModelTier;
    private threads: number;

    constructor(tier: ModelTier = 'lite', threads = 4) {
        this.tier = tier;
        this.threads = threads;
    }

    async isAvailable(): Promise<boolean> {
        const binary = await this.resolveBinaryPath();
        return binary !== null;
    }

    async setup(onProgress?: (message: string) => void): Promise<void> {
        // 1. Check/resolve binary
        this.binaryPath = await this.resolveBinaryPath();

        // Auto-bootstrap: download llama-cli directly from GitHub releases
        if (!this.binaryPath) {
            const downloaded = await this.downloadLlamaCli(onProgress);
            if (downloaded) {
                this.binaryPath = await this.resolveBinaryPath();
            }
        }

        // Legacy fallback: try npm package install
        if (!this.binaryPath) {
            const packageName = this.getPlatformPackageName();
            if (packageName) {
                const installed = await this.installSidecarBinary(packageName, onProgress);
                if (installed) {
                    this.binaryPath = await this.resolveBinaryPath();
                }
            }
        }

        if (!this.binaryPath) {
            onProgress?.('⚠ Inference engine not found. Rigour will auto-download on next attempt.');
            throw new Error(`Sidecar binary not found. Check network connection and retry.`);
        }

        let executableCheck = ensureExecutableBinary(this.binaryPath);
        // If the discovered binary is not executable, try a managed reinstall once.
        const retryPackage = this.getPlatformPackageName();
        if (!executableCheck.ok && retryPackage) {
            onProgress?.('⚠ Inference engine is present but not executable. Reinstalling managed sidecar...');
            const installed = await this.installSidecarBinary(retryPackage, onProgress);
            if (installed) {
                const refreshedPath = await this.resolveBinaryPath();
                if (refreshedPath) {
                    this.binaryPath = refreshedPath;
                    executableCheck = ensureExecutableBinary(this.binaryPath);
                }
            }
        }
        if (!executableCheck.ok) {
            throw new Error(`Sidecar binary is not executable: ${this.binaryPath}. Run: chmod +x "${this.binaryPath}"`);
        }
        if (executableCheck.fixed) {
            onProgress?.('✓ Fixed execute permission for inference engine');
        }

        onProgress?.('✓ Inference engine ready');

        // 2. Ensure model is downloaded
        if (!(await isModelCached(this.tier))) {
            const modelInfo = getModelInfo(this.tier);
            onProgress?.(`⬇ Downloading analysis model (${modelInfo.sizeHuman})...`);
        }

        this.modelPath = await ensureModel(this.tier, (msg, percent) => {
            if (percent !== undefined && percent < 100) {
                onProgress?.(`  ${msg}`);
            }
        });
        onProgress?.('✓ Model ready');
    }

    async analyze(prompt: string, options?: InferenceOptions): Promise<string> {
        if (!this.binaryPath || !this.modelPath) {
            throw new Error('Provider not set up. Call setup() first.');
        }

        const args = [
            '--model', this.modelPath,
            '--prompt', prompt,
            '--n-predict', String(options?.maxTokens || 512),
            '--threads', String(this.threads),
            '--temp', String(options?.temperature || 0.1),
            '--no-display-prompt', // Don't echo the prompt
            '--log-disable',      // Suppress llama.cpp logging
        ];

        // JSON grammar constraint if available
        if (options?.jsonMode) {
            args.push('--json');
        }

        try {
            const execOptions = {
                timeout: options?.timeout || 60000,
                maxBuffer: 10 * 1024 * 1024, // 10MB
                env: { ...process.env, LLAMA_LOG_DISABLE: '1' },
            };

            const runInference = async () => {
                return process.platform === 'win32' && this.binaryPath!.endsWith('.cmd')
                    ? await execFileAsync('cmd.exe', ['/d', '/s', '/c', [this.binaryPath!, ...args].map(quoteCmdArg).join(' ')], execOptions)
                    : await execFileAsync(this.binaryPath!, args, execOptions);
            };

            let stdout: string;
            try {
                ({ stdout } = await runInference());
            } catch (error: any) {
                // One retry path for stale/bad file mode in packaged installs.
                if (error?.code === 'EACCES') {
                    const check = ensureExecutableBinary(this.binaryPath);
                    if (check.ok) {
                        ({ stdout } = await runInference());
                    } else {
                        const packageName = this.getPlatformPackageName();
                        if (packageName) {
                            const installed = await this.installSidecarBinary(packageName);
                            if (installed) {
                                const refreshedPath = await this.resolveBinaryPath();
                                if (refreshedPath) {
                                    this.binaryPath = refreshedPath;
                                    const refreshedCheck = ensureExecutableBinary(this.binaryPath);
                                    if (refreshedCheck.ok) {
                                        ({ stdout } = await runInference());
                                        return stdout.trim();
                                    }
                                }
                            }
                        }
                        throw error;
                    }
                } else {
                    throw error;
                }
            }

            // llama.cpp sometimes outputs to stderr for diagnostics — ignore
            return stdout.trim();
        } catch (error: any) {
            if (error.killed) {
                throw new Error(`Inference timed out after ${(options?.timeout || 60000) / 1000}s`);
            }
            if (error?.code === 'EACCES') {
                throw new Error(`Inference binary is not executable: ${this.binaryPath}. Run: chmod +x "${this.binaryPath}"`);
            }
            throw new Error(`Inference failed: ${error.message}`);
        }
    }

    dispose(): void {
        // No persistent process to clean up
        this.binaryPath = null;
        this.modelPath = null;
    }

    private getPlatformKey(): string {
        return `${os.platform()}-${os.arch()}`;
    }

    private getPlatformPackageName(): string | undefined {
        const platformKey = this.getPlatformKey();
        return PLATFORM_PACKAGES[platformKey];
    }

    private async resolveBinaryPath(): Promise<string | null> {
        const platformKey = this.getPlatformKey();

        // Strategy 0: Check ~/.rigour/bin/llama-cli (auto-downloaded from GitHub releases)
        const binaryName = os.platform() === 'win32' ? 'llama-cli.exe' : 'llama-cli';
        const autoDownloadedPath = path.join(BINARY_DIR, binaryName);
        if (await fs.pathExists(autoDownloadedPath)) {
            return autoDownloadedPath;
        }

        // Strategy 1: Check @rigour-labs/brain-{platform} optional dependency
        const packageName = PLATFORM_PACKAGES[platformKey];
        if (packageName) {
            // Prefer Rigour-managed sidecar install root first to avoid brittle global/homebrew layouts.
            const managedPath = path.join(SIDECAR_INSTALL_DIR, 'node_modules', ...packageName.split('/'), 'bin', 'rigour-brain');
            const managedCandidates = os.platform() === 'win32'
                ? [managedPath + '.exe', managedPath + '.cmd', managedPath]
                : [managedPath];
            for (const managedBinPath of managedCandidates) {
                if (await fs.pathExists(managedBinPath)) {
                    return managedBinPath;
                }
            }

            try {
                const require = createRequire(import.meta.url);
                const pkgJsonPath = require.resolve(path.posix.join(packageName, 'package.json'));
                const pkgDir = path.dirname(pkgJsonPath);
                const resolvedBin = path.join(pkgDir, 'bin', 'rigour-brain');
                const resolvedCandidates = os.platform() === 'win32'
                    ? [resolvedBin + '.exe', resolvedBin + '.cmd', resolvedBin]
                    : [resolvedBin];
                for (const resolvedBinPath of resolvedCandidates) {
                    if (await fs.pathExists(resolvedBinPath)) {
                        return resolvedBinPath;
                    }
                }
            } catch {
                // Package not resolvable from current runtime
            }

            try {
                // Try to resolve from node_modules
                const possiblePaths = [
                    // From current working directory
                    path.join(process.cwd(), 'node_modules', ...packageName.split('/'), 'bin', 'rigour-brain'),
                    // From rigour-core node_modules
                    path.join(__dirname, '..', '..', '..', 'node_modules', ...packageName.split('/'), 'bin', 'rigour-brain'),
                    // From monorepo root when rigour-core is nested under packages/
                    path.join(__dirname, '..', '..', '..', '..', '..', 'node_modules', ...packageName.split('/'), 'bin', 'rigour-brain'),
                    // From global node_modules
                    path.join(os.homedir(), '.npm-global', 'lib', 'node_modules', ...packageName.split('/'), 'bin', 'rigour-brain'),
                ];

                for (const p of possiblePaths) {
                    const candidates = os.platform() === 'win32' ? [p + '.exe', p + '.cmd', p] : [p];
                    for (const binPath of candidates) {
                        if (await fs.pathExists(binPath)) {
                            return binPath;
                        }
                    }
                }
            } catch {
                // Package not installed
            }
        }

        // Strategy 2: Check ~/.rigour/bin/
        const localBin = path.join(os.homedir(), '.rigour', 'bin', 'rigour-brain');
        const localCandidates = os.platform() === 'win32'
            ? [localBin + '.exe', localBin + '.cmd', localBin]
            : [localBin];
        for (const localBinPath of localCandidates) {
            if (await fs.pathExists(localBinPath)) {
                return localBinPath;
            }
        }

        // Strategy 3: Check PATH for llama-cli (llama.cpp CLI)
        const locator = os.platform() === 'win32' ? 'where' : 'which';
        try {
            const { stdout } = await execFileAsync(locator, ['llama-cli']);
            const llamaPath = stdout.split(/\r?\n/).map(s => s.trim()).find(Boolean) || '';
            if (llamaPath && await fs.pathExists(llamaPath)) {
                return llamaPath;
            }
        } catch {
            // Not in PATH
        }

        // Strategy 4: Check for llama.cpp server-style binary names
        const altNames = ['llama-cli', 'llama', 'main'];
        for (const name of altNames) {
            try {
                const { stdout } = await execFileAsync(locator, [name]);
                const resolved = stdout.split(/\r?\n/).map(s => s.trim()).find(Boolean);
                if (resolved && await fs.pathExists(resolved)) return resolved;
            } catch {
                // Continue
            }
        }

        return null;
    }

    /**
     * Download llama-cli directly from llama.cpp GitHub releases.
     * Extracts the binary to ~/.rigour/bin/llama-cli
     */
    private async downloadLlamaCli(onProgress?: (message: string) => void): Promise<boolean> {
        const platformKey = this.getPlatformKey();
        const assetName = LLAMA_RELEASE_ASSETS[platformKey];
        if (!assetName) return false;

        const url = `${LLAMA_RELEASE_BASE}/${assetName}`;
        const zipPath = path.join(BINARY_DIR, assetName);
        const binaryName = os.platform() === 'win32' ? 'llama-cli.exe' : 'llama-cli';
        const destPath = path.join(BINARY_DIR, binaryName);

        // Already downloaded
        if (await fs.pathExists(destPath)) return true;

        onProgress?.(`⬇ Downloading inference engine (llama.cpp ${LLAMA_RELEASE_TAG})...`);
        try {
            await fs.ensureDir(BINARY_DIR);

            // Download zip
            const response = await fetch(url, { redirect: 'follow' });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const buffer = Buffer.from(await response.arrayBuffer());
            await fs.writeFile(zipPath, buffer);

            onProgress?.('  Extracting...');

            // Extract llama-cli from zip
            if (os.platform() === 'win32') {
                await execFileAsync('powershell', [
                    '-Command',
                    `Expand-Archive -Path "${zipPath}" -DestinationPath "${BINARY_DIR}/llama-extract" -Force`,
                ], { timeout: 60000 });
            } else {
                await execFileAsync('unzip', ['-o', zipPath, '-d', path.join(BINARY_DIR, 'llama-extract')], {
                    timeout: 60000,
                });
            }

            // Find llama-cli in extracted files
            const extractDir = path.join(BINARY_DIR, 'llama-extract');
            const llamaBin = await findFileRecursive(extractDir, binaryName);

            if (!llamaBin) {
                throw new Error(`${binaryName} not found in release archive`);
            }

            await fs.copy(llamaBin, destPath);

            if (os.platform() !== 'win32') {
                await fs.chmod(destPath, 0o755);
            }

            // Cleanup
            await fs.remove(zipPath);
            await fs.remove(extractDir);

            onProgress?.(`✓ Inference engine ready (${LLAMA_RELEASE_TAG})`);
            return true;
        } catch (error: any) {
            const reason = typeof error?.message === 'string' ? error.message : 'unknown error';
            onProgress?.(`⚠ Download failed: ${reason}`);
            // Cleanup partial downloads
            await fs.remove(zipPath).catch(() => {});
            await fs.remove(path.join(BINARY_DIR, 'llama-extract')).catch(() => {});
            return false;
        }
    }

    /** Legacy: install via npm brain package */
    private async installSidecarBinary(packageName: string, onProgress?: (message: string) => void): Promise<boolean> {
        onProgress?.(`⬇ Trying npm fallback: ${packageName}`);
        try {
            await fs.ensureDir(SIDECAR_INSTALL_DIR);
            await execFileAsync(
                os.platform() === 'win32' ? 'npm.cmd' : 'npm',
                ['install', '--no-save', '--no-package-lock', '--prefix', SIDECAR_INSTALL_DIR, packageName],
                {
                    cwd: SIDECAR_INSTALL_DIR,
                    timeout: 120000,
                    maxBuffer: 10 * 1024 * 1024,
                }
            );
        } catch (error: any) {
            const reason = typeof error?.message === 'string' ? error.message : 'unknown install error';
            onProgress?.(`⚠ npm install failed: ${reason}`);
            return false;
        }

        onProgress?.(`✓ Installed ${packageName}`);
        return true;
    }
}

function quoteCmdArg(value: string): string {
    return `"${value.replace(/"/g, '\\"')}"`;
}

/** Recursively find a file by name in a directory */
async function findFileRecursive(dir: string, filename: string): Promise<string | null> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            const found = await findFileRecursive(fullPath, filename);
            if (found) return found;
        } else if (entry.name === filename) {
            return fullPath;
        }
    }
    return null;
}
