import os from 'os';
import path from 'path';
import fs from 'fs-extra';
import { Logger, LogLevel } from './utils/logger.js';

/**
 * RigourSettings Interface
 * Defines the schema for ~/.rigour/settings.json global user configuration
 */
export interface RigourSettings {
  // API keys for deep analysis providers
  providers?: {
    anthropic?: string;    // Anthropic API key
    openai?: string;       // OpenAI API key
    groq?: string;         // Groq API key
    deepseek?: string;     // DeepSeek API key
    mistral?: string;      // Mistral API key
    together?: string;     // Together API key
    gemini?: string;       // Google Gemini key
    ollama?: string;       // Ollama key (usually empty)
    [key: string]: string | undefined; // Any other provider
  };

  // Default deep scan configuration
  deep?: {
    defaultProvider?: string;  // Which provider to use by default
    defaultModel?: string;     // Model name override
    apiBaseUrl?: string;       // Custom API base URL
    maxTokens?: number;        // Override max tokens
    temperature?: number;      // Override temperature
  };

  // Multi-agent configuration
  agents?: {
    [agentName: string]: {
      model?: string;        // Model to use for this agent
      provider?: string;     // Provider for this agent
      fallback?: string;     // Fallback model
    };
  };

  // CLI preferences
  cli?: {
    defaultPreset?: string;  // Default preset for rigour init
    colorOutput?: boolean;   // Enable/disable colors
    verboseOutput?: boolean; // Enable verbose logging
  };
}

/**
 * Resolved deep options from CLI flags merged with settings.json
 */
export interface ResolvedDeepOptions {
  apiKey?: string;
  provider?: string;
  apiBaseUrl?: string;
  modelName?: string;
  maxTokens?: number;
  temperature?: number;
}

/**
 * CLI options that may override settings
 */
export interface CLIDeepOptions {
  apiKey?: string;
  provider?: string;
  apiBaseUrl?: string;
  modelName?: string;
  maxTokens?: number;
  temperature?: number;
}

/**
 * Get the settings file path: ~/.rigour/settings.json
 */
export function getSettingsPath(): string {
  const homeDir = os.homedir();
  return path.join(homeDir, '.rigour', 'settings.json');
}

/**
 * Load settings from ~/.rigour/settings.json
 * Returns empty object if file not found or is malformed
 */
export function loadSettings(): RigourSettings {
  const settingsPath = getSettingsPath();

  try {
    if (!fs.existsSync(settingsPath)) {
      Logger.debug(`Settings file not found at ${settingsPath}`);
      return {};
    }

    const content = fs.readFileSync(settingsPath, 'utf-8');
    const settings = JSON.parse(content) as RigourSettings;
    Logger.debug(`Settings loaded from ${settingsPath}`);
    return settings;
  } catch (error) {
    if (error instanceof SyntaxError) {
      Logger.warn(`Malformed JSON in ${settingsPath}: ${error.message}`);
    } else if (error instanceof Error) {
      Logger.warn(`Failed to read settings from ${settingsPath}: ${error.message}`);
    } else {
      Logger.warn(`Failed to read settings from ${settingsPath}`);
    }
    return {};
  }
}

/**
 * Save settings to ~/.rigour/settings.json
 */
export function saveSettings(settings: RigourSettings): void {
  const settingsPath = getSettingsPath();
  const settingsDir = path.dirname(settingsPath);

  try {
    // Ensure directory exists
    fs.ensureDirSync(settingsDir);

    // Write with pretty formatting (2-space indent)
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
    Logger.debug(`Settings saved to ${settingsPath}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    Logger.error(`Failed to save settings to ${settingsPath}: ${message}`);
    throw error;
  }
}

/**
 * Map common provider names to their settings.json key
 * This allows --provider claude to resolve to anthropic API key
 */
function normalizeProviderName(provider: string): string {
  const mapping: { [key: string]: string } = {
    'claude': 'anthropic',
    'anthropic': 'anthropic',
    'gpt': 'openai',
    'openai': 'openai',
    'groq': 'groq',
    'deepseek': 'deepseek',
    'mistral': 'mistral',
    'together': 'together',
    'gemini': 'gemini',
    'google': 'gemini',
    'ollama': 'ollama',
  };

  return mapping[provider.toLowerCase()] || provider;
}

/**
 * Resolve deep analysis options by merging CLI flags with settings.json
 * CLI flags always take precedence over settings.json values
 *
 * @param cliOptions CLI flags provided by user
 * @returns Merged options with CLI taking precedence
 */
export function resolveDeepOptions(cliOptions: CLIDeepOptions): ResolvedDeepOptions {
  const settings = loadSettings();
  const result: ResolvedDeepOptions = {};

  // 1. Start with settings.json defaults
  if (settings.deep?.apiBaseUrl) {
    result.apiBaseUrl = settings.deep.apiBaseUrl;
  }
  if (settings.deep?.maxTokens) {
    result.maxTokens = settings.deep.maxTokens;
  }
  if (settings.deep?.temperature) {
    result.temperature = settings.deep.temperature;
  }

  // 2. Apply provider selection (settings or default)
  let selectedProvider = settings.deep?.defaultProvider || 'anthropic';
  if (cliOptions.provider) {
    selectedProvider = cliOptions.provider;
  }
  result.provider = selectedProvider;

  // 3. Apply model selection (settings or default)
  if (settings.deep?.defaultModel) {
    result.modelName = settings.deep.defaultModel;
  }
  if (cliOptions.modelName) {
    result.modelName = cliOptions.modelName;
  }

  // 4. Resolve API key
  // CLI flag takes highest precedence
  if (cliOptions.apiKey) {
    result.apiKey = cliOptions.apiKey;
  } else if (settings.providers) {
    // Otherwise look up provider key in settings.providers
    const normalizedProvider = normalizeProviderName(selectedProvider);
    const apiKey = settings.providers[normalizedProvider];
    if (apiKey) {
      result.apiKey = apiKey;
    }
  }

  // 5. Override with CLI flags (highest priority)
  if (cliOptions.apiBaseUrl) {
    result.apiBaseUrl = cliOptions.apiBaseUrl;
  }
  if (cliOptions.maxTokens) {
    result.maxTokens = cliOptions.maxTokens;
  }
  if (cliOptions.temperature) {
    result.temperature = cliOptions.temperature;
  }

  return result;
}

/**
 * Get a specific provider's API key from settings
 * Supports both normalized names (claude -> anthropic) and exact keys
 */
export function getProviderKey(providerName: string): string | undefined {
  const settings = loadSettings();
  if (!settings.providers) {
    return undefined;
  }

  const normalized = normalizeProviderName(providerName);
  return settings.providers[normalized];
}

/**
 * Get agent configuration from settings
 */
export function getAgentConfig(
  agentName: string
): { model?: string; provider?: string; fallback?: string } | undefined {
  const settings = loadSettings();
  return settings.agents?.[agentName];
}

/**
 * Get CLI preferences from settings
 */
export function getCliPreferences(): RigourSettings['cli'] {
  const settings = loadSettings();
  return settings.cli || {};
}

/**
 * Update a specific provider key in settings
 */
export function updateProviderKey(provider: string, apiKey: string): void {
  const settings = loadSettings();
  const normalized = normalizeProviderName(provider);

  if (!settings.providers) {
    settings.providers = {};
  }

  settings.providers[normalized] = apiKey;
  saveSettings(settings);
}

/**
 * Remove a provider key from settings
 */
export function removeProviderKey(provider: string): void {
  const settings = loadSettings();
  const normalized = normalizeProviderName(provider);

  if (settings.providers && settings.providers[normalized]) {
    delete settings.providers[normalized];
    saveSettings(settings);
  }
}
