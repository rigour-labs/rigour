import chalk from 'chalk';
import path from 'path';
import fs from 'fs-extra';
import { loadSettings, getSettingsPath, isModelCached, getModelsDir } from '@rigour-labs/core';
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
    const hasDeep = isModelCached('deep');
    const hasPro = isModelCached('pro');
    if (hasDeep) console.log(chalk.green('    ✔ Local model: deep (Qwen2.5-Coder-0.5B, 350MB)'));
    if (hasPro) console.log(chalk.green('    ✔ Local model: pro (Qwen2.5-Coder-1.5B, 900MB)'));
    if (!hasDeep && !hasPro) {
        console.log(chalk.yellow('    ○ No local models cached'));
        console.log(chalk.dim(`      Models dir: ${getModelsDir()}`));
    }

    // Check sidecar binary
    let hasSidecar = false;
    try {
        const { execSync } = await import('child_process');
        execSync('which llama-cli 2>/dev/null || which rigour-brain 2>/dev/null', { encoding: 'utf-8', timeout: 3000 });
        hasSidecar = true;
        console.log(chalk.green('    ✔ Inference binary found'));
    } catch {
        const binDir = path.join(getModelsDir(), '..', 'bin');
        if (fs.existsSync(path.join(binDir, 'rigour-brain')) || fs.existsSync(path.join(binDir, 'llama-cli'))) {
            hasSidecar = true;
            console.log(chalk.green('    ✔ Inference binary found'));
        } else if (configuredKeys.length === 0) {
            console.log(chalk.yellow('    ○ No local inference binary'));
        }
    }

    // Cloud readiness
    const hasCloudKey = configuredKeys.length > 0;
    const hasLocalReady = hasSidecar && (hasDeep || hasPro);

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
        console.log(`    ${chalk.cyan('rigour check --deep')}  ${chalk.dim('# auto-downloads 350MB model')}`);
    }

    // ── Section 5: Installation Methods ──
    console.log(chalk.bold('\n  Installation Methods:'));
    console.log(chalk.dim('    Global:  ') + chalk.cyan('npm install -g @rigour-labs/cli'));
    console.log(chalk.dim('    Local:   ') + chalk.cyan('npm install --save-dev @rigour-labs/cli'));
    console.log(chalk.dim('    No-install: ') + chalk.cyan('npx @rigour-labs/cli check'));
    console.log(chalk.dim('    MCP:     ') + chalk.cyan('packages/rigour-mcp/dist/index.js'));
    console.log('');
}
