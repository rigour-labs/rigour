/**
 * Sidecar provider: local inference with llama.cpp's llama-cli.
 *
 * Engine resolution, first binary that passes `--version` wins:
 *   1. managed install of the pinned release (~/.rigour/bin/llama-<tag>/)
 *   2. legacy locations: ~/.rigour/bin/llama-cli, @rigour-labs/brain-<platform>
 *   3. llama-cli on PATH
 * If none runs, the pinned release is downloaded and installed.
 *
 * Code never leaves the machine: prompts go to a local child process.
 */
import path from 'path';
import os from 'os';
import fs from 'fs-extra';
import { createRequire } from 'module';
import type { InferenceProvider, InferenceOptions, ModelTier } from './types.js';
import { ensureModel, getCachedModel, type CachedModel } from './model-manager.js';
import { ensureExecutableBinary } from './executable.js';
import { installLlamaEngine, llamaBinaryName, managedEngineDir, managedEnginePath, probeBinary } from './llama-engine.js';
import { buildLlamaArgs, cleanLlamaOutput, FINDINGS_JSON_SCHEMA, ProcessTimeoutError, runProcess } from './llama-process.js';
import { RIGOUR_DIR } from '../storage/db.js';

const DEFAULT_TIMEOUT_MS = 60_000;

/** Platform → legacy npm package that may carry a rigour-brain binary. */
const PLATFORM_PACKAGES: Record<string, string> = {
    'darwin-arm64': '@rigour-labs/brain-darwin-arm64',
    'darwin-x64': '@rigour-labs/brain-darwin-x64',
    'linux-x64': '@rigour-labs/brain-linux-x64',
    'linux-arm64': '@rigour-labs/brain-linux-arm64',
    'win32-x64': '@rigour-labs/brain-win-x64',
};

export interface ActiveModel {
    name: string;
    filename: string;
    fallback: boolean;
}

export class SidecarProvider implements InferenceProvider {
    readonly name = 'sidecar';
    private binaryPath: string | null = null;
    private model: CachedModel | null = null;
    private schemaPath: string | null = null;
    private tier: ModelTier;
    private threads: number;

    constructor(tier: ModelTier = 'lite', threads = 4) {
        this.tier = tier;
        this.threads = threads;
    }

    /** True when a llama-cli that actually runs is installed. */
    async isAvailable(): Promise<boolean> {
        return (await this.findEngine()) !== null;
    }

    /** The llama-cli this provider would use and its version, or null if none runs. */
    async findEngine(): Promise<{ path: string; version?: string } | null> {
        const binary = await this.resolveBinaryPath();
        if (!binary) return null;
        return { path: binary, version: (await probeBinary(binary)).version };
    }

    /** Install the engine and model for this tier without running inference. */
    async prepare(onProgress?: (message: string) => void): Promise<void> {
        await this.setup(onProgress);
        this.dispose();
    }

    async setup(onProgress?: (message: string) => void): Promise<void> {
        this.binaryPath = await this.resolveBinaryPath() ?? await installLlamaEngine(onProgress);
        onProgress?.('✓ Inference engine ready');

        await ensureModel(this.tier, (msg, percent) => {
            if (percent !== undefined && percent < 100) onProgress?.(`  ${msg}`);
        });
        this.model = await getCachedModel(this.tier);
        if (!this.model) {
            throw new Error(`Model for tier "${this.tier}" is not cached after download.`);
        }
        if (this.model.fallback) {
            onProgress?.(`  Using stock model ${this.model.info.name} (fine-tuned model not available).`);
        }
        this.schemaPath = await writeFindingsSchema();
        onProgress?.('✓ Model ready');
    }

    /** The model file setup() loaded, or null before setup. */
    getActiveModel(): ActiveModel | null {
        if (!this.model) return null;
        return { name: this.model.info.name, filename: this.model.info.filename, fallback: this.model.fallback };
    }

    async analyze(prompt: string, options?: InferenceOptions): Promise<string> {
        if (!this.binaryPath || !this.model) {
            throw new Error('Provider not set up. Call setup() first.');
        }

        const timeoutMs = options?.timeout || DEFAULT_TIMEOUT_MS;
        const args = buildLlamaArgs({
            modelPath: this.model.path,
            prompt,
            maxTokens: options?.maxTokens || 1024,
            threads: this.threads,
            temperature: options?.temperature ?? 0.1,
            schemaPath: options?.jsonMode ? this.schemaPath ?? undefined : undefined,
        });

        let result;
        try {
            result = await runProcess(this.binaryPath, args, { timeoutMs });
        } catch (error: any) {
            if (error instanceof ProcessTimeoutError) throw new Error(`Inference ${error.message}`);
            throw new Error(`Inference failed: ${error?.message ?? String(error)}`);
        }
        if (result.code !== 0) {
            const detail = result.stderr.trim().split(/\r?\n/).slice(-3).join(' | ');
            throw new Error(`Inference failed (exit ${result.code}): ${detail}`);
        }
        return cleanLlamaOutput(result.stdout);
    }

    dispose(): void {
        this.binaryPath = null;
        this.model = null;
    }

    /** First candidate binary that exists, is executable and passes the probe. */
    private async resolveBinaryPath(): Promise<string | null> {
        for (const candidate of await this.candidateBinaries()) {
            if (!(await fs.pathExists(candidate))) continue;
            if (!ensureExecutableBinary(candidate).ok) continue;
            if ((await probeBinary(candidate)).ok) return candidate;
        }
        return null;
    }

    private async candidateBinaries(): Promise<string[]> {
        const candidates = [
            managedEnginePath(),
            path.join(RIGOUR_DIR, 'bin', llamaBinaryName()),
            ...brainPackageBinaries(),
        ];
        const onPath = await findOnPath('llama-cli');
        if (onPath) candidates.push(onPath);
        return candidates.filter((c, i) => candidates.indexOf(c) === i);
    }
}

function brainPackageBinaries(): string[] {
    const packageName = PLATFORM_PACKAGES[`${os.platform()}-${os.arch()}`];
    if (!packageName) return [];
    const suffixes = os.platform() === 'win32' ? ['.exe', '.cmd', ''] : [''];
    try {
        const require = createRequire(import.meta.url);
        const pkgDir = path.dirname(require.resolve(path.posix.join(packageName, 'package.json')));
        return suffixes.map(s => path.join(pkgDir, 'bin', `rigour-brain${s}`));
    } catch {
        return [];
    }
}

async function findOnPath(name: string): Promise<string | null> {
    const locator = os.platform() === 'win32' ? 'where' : 'which';
    try {
        const { code, stdout } = await runProcess(locator, [name], { timeoutMs: 5_000 });
        if (code !== 0) return null;
        return stdout.split(/\r?\n/).map(s => s.trim()).find(Boolean) ?? null;
    } catch {
        return null;
    }
}

async function writeFindingsSchema(): Promise<string> {
    const schemaPath = path.join(managedEngineDir(), '..', 'findings.schema.json');
    await fs.ensureDir(path.dirname(schemaPath));
    await fs.writeJson(schemaPath, FINDINGS_JSON_SCHEMA);
    return schemaPath;
}
