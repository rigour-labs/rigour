import chalk from 'chalk';
import { loadSettings, saveSettings, getSettingsPath, updateProviderKey, removeProviderKey } from '@rigour-labs/core';
import type { RigourSettings } from '@rigour-labs/core';

/**
 * `rigour settings` — manage ~/.rigour/settings.json
 *
 * Like Claude Code's settings.json or Gemini CLI's config.
 * Stores API keys, default provider, multi-agent config, CLI preferences.
 */

export function settingsShowCommand() {
    const settingsPath = getSettingsPath();
    const settings = loadSettings();

    console.log(chalk.bold.cyan('\n  Rigour Settings'));
    console.log(chalk.dim(`  ${settingsPath}\n`));

    if (Object.keys(settings).length === 0) {
        console.log(chalk.dim('  No settings configured yet.\n'));
        console.log(chalk.dim('  Quick start:'));
        console.log(chalk.dim('    rigour settings set-key anthropic sk-ant-xxx'));
        console.log(chalk.dim('    rigour settings set-key openai sk-xxx'));
        console.log(chalk.dim('    rigour settings set provider anthropic'));
        console.log('');
        return;
    }

    // Show providers
    if (settings.providers && Object.keys(settings.providers).length > 0) {
        console.log(chalk.bold('  Providers:'));
        for (const [name, key] of Object.entries(settings.providers)) {
            if (key) {
                const masked = maskKey(key);
                console.log(`    ${chalk.green(name)}: ${chalk.dim(masked)}`);
            }
        }
        console.log('');
    }

    // Show deep defaults
    if (settings.deep) {
        console.log(chalk.bold('  Deep Analysis Defaults:'));
        if (settings.deep.defaultProvider) console.log(`    Provider: ${chalk.cyan(settings.deep.defaultProvider)}`);
        if (settings.deep.defaultModel) console.log(`    Model: ${chalk.cyan(settings.deep.defaultModel)}`);
        if (settings.deep.apiBaseUrl) console.log(`    API Base: ${chalk.cyan(settings.deep.apiBaseUrl)}`);
        if (settings.deep.maxTokens) console.log(`    Max Tokens: ${settings.deep.maxTokens}`);
        if (settings.deep.temperature !== undefined) console.log(`    Temperature: ${settings.deep.temperature}`);
        console.log('');
    }

    // Show agent configs
    if (settings.agents && Object.keys(settings.agents).length > 0) {
        console.log(chalk.bold('  Agent Configurations:'));
        for (const [name, config] of Object.entries(settings.agents)) {
            const parts = [];
            if (config.model) parts.push(`model: ${config.model}`);
            if (config.provider) parts.push(`provider: ${config.provider}`);
            if (config.fallback) parts.push(`fallback: ${config.fallback}`);
            console.log(`    ${chalk.green(name)}: ${chalk.dim(parts.join(', '))}`);
        }
        console.log('');
    }

    // Show CLI prefs
    if (settings.cli) {
        console.log(chalk.bold('  CLI Preferences:'));
        if (settings.cli.defaultPreset) console.log(`    Default Preset: ${settings.cli.defaultPreset}`);
        if (settings.cli.colorOutput !== undefined) console.log(`    Color Output: ${settings.cli.colorOutput}`);
        if (settings.cli.verboseOutput !== undefined) console.log(`    Verbose: ${settings.cli.verboseOutput}`);
        console.log('');
    }
}

export function settingsSetKeyCommand(provider: string, apiKey: string) {
    updateProviderKey(provider, apiKey);
    const masked = maskKey(apiKey);
    console.log(chalk.green(`  ✓ ${provider} API key saved: ${masked}`));
    console.log(chalk.dim(`    Stored in ${getSettingsPath()}`));
    console.log('');
    console.log(chalk.dim(`  Usage: rigour check --deep --provider ${provider}`));
    console.log(chalk.dim(`  Or set as default: rigour settings set provider ${provider}`));
}

export function settingsRemoveKeyCommand(provider: string) {
    removeProviderKey(provider);
    console.log(chalk.green(`  ✓ ${provider} API key removed`));
}

export function settingsSetCommand(key: string, value: string) {
    const settings = loadSettings();

    // Parse dot-notation keys: "deep.defaultProvider" -> settings.deep.defaultProvider
    const parts = key.split('.');
    let target: any = settings;

    for (let i = 0; i < parts.length - 1; i++) {
        if (!target[parts[i]]) target[parts[i]] = {};
        target = target[parts[i]];
    }

    const lastKey = parts[parts.length - 1];

    // Auto-convert booleans and numbers
    if (value === 'true') target[lastKey] = true;
    else if (value === 'false') target[lastKey] = false;
    else if (!isNaN(Number(value)) && value.trim() !== '') target[lastKey] = Number(value);
    else target[lastKey] = value;

    saveSettings(settings);
    console.log(chalk.green(`  ✓ ${key} = ${value}`));
}

export function settingsGetCommand(key: string) {
    const settings = loadSettings();
    const parts = key.split('.');
    let value: any = settings;

    for (const part of parts) {
        if (value === undefined || value === null) break;
        value = value[part];
    }

    if (value === undefined) {
        console.log(chalk.dim(`  ${key} is not set`));
    } else if (typeof value === 'object') {
        console.log(`  ${key} = ${JSON.stringify(value, null, 2)}`);
    } else {
        console.log(`  ${key} = ${value}`);
    }
}

export function settingsResetCommand() {
    saveSettings({});
    console.log(chalk.green('  ✓ Settings reset to defaults'));
    console.log(chalk.dim(`    ${getSettingsPath()}`));
}

export function settingsPathCommand() {
    console.log(getSettingsPath());
}

function maskKey(key: string): string {
    if (key.length <= 8) return '***';
    return key.substring(0, 6) + '...' + key.substring(key.length - 4);
}
