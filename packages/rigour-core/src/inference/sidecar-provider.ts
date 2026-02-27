/**
 * Sidecar Binary Provider — runs inference via pre-compiled llama.cpp binary.
 * Binary ships as @rigour-labs/brain-{platform} optional npm dependency.
 * Falls back to PATH lookup for development/manual installs.
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

/** Platform → npm package mapping */
const PLATFORM_PACKAGES: Record<string, string> = {
    'darwin-arm64': '@rigour-labs/brain-darwin-arm64',
    'darwin-x64': '@rigour-labs/brain-darwin-x64',
    'linux-x64': '@rigour-labs/brain-linux-x64',
    'linux-arm64': '@rigour-labs/brain-linux-arm64',
    'win32-x64': '@rigour-labs/brain-win-x64',
};

export class SidecarProvider implements InferenceProvider {
    readonly name = 'sidecar';
    private binaryPath: string | null = null;
    private modelPath: string | null = null;
    private tier: ModelTier;
    private threads: number;

    constructor(tier: ModelTier = 'deep', threads = 4) {
        this.tier = tier;
        this.threads = threads;
    }

    async isAvailable(): Promise<boolean> {
        const binary = await this.resolveBinaryPath();
        return binary !== null;
    }

    async setup(onProgress?: (message: string) => void): Promise<void> {
        const packageName = this.getPlatformPackageName();

        // 1. Check/resolve binary
        this.binaryPath = await this.resolveBinaryPath();

        // Auto-bootstrap local sidecar when missing.
        if (!this.binaryPath && packageName) {
            const installed = await this.installSidecarBinary(packageName, onProgress);
            if (installed) {
                this.binaryPath = await this.resolveBinaryPath();
            }
        }

        if (!this.binaryPath) {
            onProgress?.('⚠ Inference engine not found. Install @rigour-labs/brain-* or add llama-cli to PATH');
            const installHint = packageName || `@rigour-labs/brain-${this.getPlatformKey()}`;
            throw new Error(`Sidecar binary not found. Run: npm install ${installHint}`);
        }

        let executableCheck = ensureExecutableBinary(this.binaryPath);
        // If the discovered binary is not executable, try a managed reinstall once.
        if (!executableCheck.ok && packageName) {
            onProgress?.('⚠ Inference engine is present but not executable. Reinstalling managed sidecar...');
            const installed = await this.installSidecarBinary(packageName, onProgress);
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

    private async installSidecarBinary(packageName: string, onProgress?: (message: string) => void): Promise<boolean> {
        onProgress?.(`⬇ Inference engine missing. Attempting automatic install: ${packageName}`);
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
            onProgress?.(`⚠ Auto-install failed: ${reason}`);
            return false;
        }

        onProgress?.(`✓ Installed ${packageName}`);
        return true;
    }
}

function quoteCmdArg(value: string): string {
    return `"${value.replace(/"/g, '\\"')}"`;
}
