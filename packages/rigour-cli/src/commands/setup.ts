import chalk from 'chalk';
import path from 'path';
import fs from 'fs-extra';
import { loadSettings, getSettingsPath, isModelCached, getModelsDir, MODELS, managedEnginePath, probeBinary } from '@rigour-labs/core';
import { getCliVersion } from '../utils/cli-version.js';

export async function setupCommand() {
    console.log(chalk.bold.cyan('\n🛠️ Rigour Labs | Setup & System Check\n'));

    // ── Section 1: Installation Status ──
    console.log(chalk.bold('  Installation'));
    const cliVersion = getCliVersion();
    if (cliVersion) {
        console.log(chalk.green(`    ✔ Rigour CLI ${cliVersion}`));
    }

    // Check if rigour.yml exists in cwd
    const hasConfig = fs.existsSync(path.join(process.cwd(), 'rigour.yml'));
    if (hasConfig) {
        console.log(chalk.green('    ✔ rigour.yml found in current directory'));
    } else {
        console.log(chalk.yellow('    ○ No rigour.yml — run `rigour init` to set up'));
    }

    // ── Section 2: Settings & API Keys ──
    console.log(chalk.bold('\n  Settings'));
    const settingsPath = getSettingsPath();
    const settings = loadSettings();
    const providers = settings.providers || {};
    const configuredKeys = Object.entries(providers).filter(([_, key]) => !!key);

    if (configuredKeys.length > 0) {
        for (const [name, key] of configuredKeys) {
            if (key) {
                const masked = key.length > 8 ? key.substring(0, 6) + '...' + key.substring(key.length - 4) : '***';
                console.log(chalk.green(`    ✔ ${name}: ${chalk.dim(masked)}`));
            }
        }
    } else {
        console.log(chalk.yellow('    ○ No API keys configured'));
        console.log(chalk.dim(`      ${settingsPath}`));
    }

    if (settings.deep?.defaultProvider) {
        console.log(chalk.green(`    ✔ Default provider: ${settings.deep.defaultProvider}`));
    }

    // ── Section 3: Deep Analysis Readiness ──
    console.log(chalk.bold('\n  Deep Analysis'));

    // Check local models
    const hasDeep = await isModelCached('deep');
    const hasLite = await isModelCached('lite');
    if (hasDeep) console.log(chalk.green(`    ✔ Local model: deep (${MODELS.deep.name}, ${MODELS.deep.sizeHuman})`));
    if (hasLite) console.log(chalk.green(`    ✔ Local model: lite (${MODELS.lite.name}, ${MODELS.lite.sizeHuman})`));
    if (!hasDeep && !hasLite) {
        console.log(chalk.yellow('    ○ No local models cached'));
        console.log(chalk.dim(`      Models dir: ${getModelsDir()}`));
    }

    // The engine inference will use: the one `rigour deep pull` installs, else llama-cli on PATH,
    // each accepted only if it actually runs (a placeholder script does not).
    const engine = await findWorkingEngine();
    const hasSidecar = engine !== undefined;
    if (engine) console.log(chalk.green(`    ✔ Inference engine: ${engine}`));
    else if (configuredKeys.length === 0) console.log(chalk.yellow('    ○ No local inference engine (rigour deep pull installs one)'));

    // Cloud readiness
    const hasCloudKey = configuredKeys.length > 0;
    const hasLocalReady = hasSidecar && (hasDeep || hasLite);

    if (hasCloudKey || hasLocalReady) {
        console.log(chalk.green.bold('\n  ✓ Deep analysis is ready'));
    } else {
        console.log(chalk.yellow.bold('\n  ⚠ Deep analysis not configured'));
    }

    // ── Section 4: Quick Setup Commands ──
    if (!hasCloudKey && !hasLocalReady) {
        console.log(chalk.bold('\n  Quick Setup:'));
        console.log(chalk.dim('    # Option A: Cloud (recommended)'));
        console.log(`    ${chalk.cyan('rigour settings set-key anthropic')} ${chalk.dim('sk-ant-xxx')}`);
        console.log(`    ${chalk.cyan('rigour settings set-key openai')} ${chalk.dim('sk-xxx')}`);
        console.log(`    ${chalk.cyan('rigour settings set-key groq')} ${chalk.dim('gsk_xxx')}`);
        console.log('');
        console.log(chalk.dim('    # Option B: 100% Local'));
        console.log(`    ${chalk.cyan('rigour check --deep')}  ${chalk.dim(`# downloads the ${MODELS.lite.sizeHuman} lite model`)}`);
    }

    // ── Section 5: Installation Methods ──
    console.log(chalk.bold('\n  Installation Methods:'));
    console.log(chalk.dim('    Global:  ') + chalk.cyan('npm install -g @rigour-labs/cli'));
    console.log(chalk.dim('    Local:   ') + chalk.cyan('npm install --save-dev @rigour-labs/cli'));
    console.log(chalk.dim('    No-install: ') + chalk.cyan('npx @rigour-labs/cli check'));
    console.log(chalk.dim('    Diagnostics: ') + chalk.cyan('rigour doctor'));
    console.log(chalk.dim('    MCP:     ') + chalk.cyan('packages/rigour-mcp/dist/index.js'));
    console.log('');
}

async function findWorkingEngine(): Promise<string | undefined> {
    const candidates = [managedEnginePath()];
    try {
        const { execFileSync } = await import('child_process');
        const onPath = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['llama-cli'], { encoding: 'utf-8', timeout: 3000 }).split(/\r?\n/)[0]?.trim();
        if (onPath) candidates.push(onPath);
    } catch {
        // Not on PATH.
    }
    for (const candidate of candidates) {
        if ((await probeBinary(candidate)).ok) return candidate;
    }
    return undefined;
}
