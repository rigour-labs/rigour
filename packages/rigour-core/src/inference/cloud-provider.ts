/**
 * Cloud API Provider — runs inference via ANY cloud LLM API.
 *
 * The moat is local-first. But if a user brings their own key,
 * we don't block them. No limitations. Support EVERY provider:
 *
 * - 'claude'/'anthropic' → Anthropic SDK (native)
 * - Everything else → OpenAI-compatible SDK (works with OpenAI, Gemini, Groq,
 *   Mistral, Together, Fireworks, Perplexity, DeepSeek, self-hosted vLLM,
 *   Ollama, LM Studio, any OpenAI-compatible endpoint)
 *
 * User provides: api_key + provider name + optional base_url + optional model_name
 * We figure out the rest. Their key, their choice.
 */
import type { InferenceProvider, InferenceOptions } from './types.js';

/** Default models per provider (user can override via model_name) */
const DEFAULT_MODELS: Record<string, string> = {
    claude: 'claude-opus-4-6',
    anthropic: 'claude-sonnet-4-6',
    openai: 'gpt-4o-mini',
    gemini: 'gemini-3-flash',
    groq: 'llama-3.1-70b-versatile',
    mistral: 'mistral-large-latest',
    together: 'meta-llama/Llama-3.1-70B-Instruct-Turbo',
    fireworks: 'accounts/fireworks/models/llama-v3p1-70b-instruct',
    deepseek: 'deepseek-coder',
    perplexity: 'llama-3.1-sonar-large-128k-online',
    ollama: 'qwen2.5-coder:7b',
    lmstudio: 'qwen2.5-coder-7b-instruct',
};

/** Default base URLs per provider */
const DEFAULT_BASE_URLS: Record<string, string> = {
    openai: 'https://api.openai.com/v1',
    gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
    groq: 'https://api.groq.com/openai/v1',
    mistral: 'https://api.mistral.ai/v1',
    together: 'https://api.together.xyz/v1',
    fireworks: 'https://api.fireworks.ai/inference/v1',
    deepseek: 'https://api.deepseek.com/v1',
    perplexity: 'https://api.perplexity.ai',
    ollama: 'http://localhost:11434/v1',
    lmstudio: 'http://localhost:1234/v1',
};

export class CloudProvider implements InferenceProvider {
    readonly name: string;
    private client: any = null;
    private providerName: string;
    private apiKey: string;
    private baseUrl?: string;
    private modelName: string;
    private isClaude: boolean;

    constructor(providerName: string, apiKey: string, options?: { baseUrl?: string; modelName?: string }) {
        if (!apiKey || apiKey.trim().length === 0) {
            throw new Error(`API key cannot be empty for provider "${providerName}"`);
        }
        this.providerName = providerName.toLowerCase();
        this.apiKey = apiKey.trim();
        this.baseUrl = options?.baseUrl;
        this.modelName = options?.modelName || DEFAULT_MODELS[this.providerName] || 'gpt-4o-mini';
        this.isClaude = this.providerName === 'claude' || this.providerName === 'anthropic';
        this.name = `cloud-${this.providerName}`;
    }

    async isAvailable(): Promise<boolean> {
        return !!this.apiKey;
    }

    async setup(onProgress?: (message: string) => void): Promise<void> {
        if (this.isClaude) {
            try {
                const { default: Anthropic } = await import('@anthropic-ai/sdk');
                this.client = new Anthropic({ apiKey: this.apiKey });
                onProgress?.(`✓ ${this.providerName} API connected (model: ${this.modelName})`);
            } catch {
                throw new Error(
                    'Claude API SDK not installed. Run: npm install @anthropic-ai/sdk'
                );
            }
        } else {
            // OpenAI-compatible SDK — works with literally everything.
            // OpenAI, Groq, Mistral, Together, Fireworks, DeepSeek, Perplexity,
            // Gemini, Ollama, LM Studio, vLLM, any OpenAI-compatible endpoint.
            // No limitations. User's key, user's choice.
            try {
                const { default: OpenAI } = await import('openai');
                const baseURL = this.baseUrl || DEFAULT_BASE_URLS[this.providerName] || undefined;
                this.client = new OpenAI({
                    apiKey: this.apiKey,
                    ...(baseURL ? { baseURL } : {}),
                });
                onProgress?.(`✓ ${this.providerName} API connected (model: ${this.modelName})`);
            } catch {
                throw new Error(
                    'OpenAI SDK not installed (used for all OpenAI-compatible APIs). Run: npm install openai'
                );
            }
        }
    }

    async analyze(prompt: string, options?: InferenceOptions): Promise<string> {
        if (!this.client) {
            throw new Error('Provider not set up. Call setup() first.');
        }

        if (this.isClaude) {
            return this.analyzeClaude(prompt, options);
        } else {
            return this.analyzeOpenAICompat(prompt, options);
        }
    }

    private async analyzeClaude(prompt: string, options?: InferenceOptions): Promise<string> {
        const response = await this.client.messages.create({
            model: this.modelName,
            max_tokens: options?.maxTokens || 2048,
            temperature: options?.temperature || 0.1,
            messages: [
                { role: 'user', content: prompt }
            ],
        });

        const textBlock = response.content.find((b: any) => b.type === 'text');
        if (!textBlock?.text) {
            throw new Error(`Empty response from ${this.providerName} API (model: ${this.modelName}). Response had ${response.content.length} blocks but no text.`);
        }
        return textBlock.text;
    }

    private async analyzeOpenAICompat(prompt: string, options?: InferenceOptions): Promise<string> {
        const response = await this.client.chat.completions.create({
            model: this.modelName,
            max_tokens: options?.maxTokens || 2048,
            temperature: options?.temperature || 0.1,
            messages: [
                { role: 'user', content: prompt }
            ],
            ...(options?.jsonMode ? { response_format: { type: 'json_object' } } : {}),
        });

        const content = response.choices[0]?.message?.content;
        if (!content) {
            throw new Error(`Empty response from ${this.providerName} API (model: ${this.modelName}). No content in choices.`);
        }
        return content;
    }

    dispose(): void {
        this.client = null;
    }
}
