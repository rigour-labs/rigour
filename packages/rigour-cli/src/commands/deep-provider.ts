/**
 * Which model provider a run uses, and the key it sends. A cloud provider named on the command line
 * with no key is an error, not a quiet switch to the small local model: a CI job whose secret is
 * missing would otherwise report a frontier review that never happened. A model server on this
 * machine (Ollama, LM Studio) needs no key, so asking for one by name runs it.
 */
import { UsageError } from './review-config.js';

/** OpenAI-compatible servers on this machine: they take any key, so one is supplied for them. */
const LOCAL_SERVERS = new Set(['ollama', 'lmstudio']);

export function deepProvider(requested: string | undefined, resolved: string | undefined, apiKey: string | undefined): { provider: string; apiKey?: string } {
    if (apiKey) return { provider: resolved || 'claude', apiKey };
    const name = requested?.toLowerCase();
    if (name && LOCAL_SERVERS.has(name)) return { provider: name, apiKey: name };
    if (name && name !== 'local') {
        throw new UsageError(`--provider ${requested} needs an API key: set RIGOUR_API_KEY (a CI secret), pass -k, or run \`rigour settings set-key ${requested} <key>\`. Use --provider local for the built-in local model.`);
    }
    return { provider: 'local' };
}
