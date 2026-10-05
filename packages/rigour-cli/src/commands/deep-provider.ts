/**
 * Which deep provider a run uses. A cloud provider named on the command line with no key is an
 * error, not a quiet switch to the small local model: a CI job whose secret is missing would
 * otherwise report a frontier review that never happened.
 */
import { UsageError } from './review-config.js';

/** Providers that run without a key: the built-in local model and an Ollama server. */
const KEYLESS = new Set(['local', 'ollama']);

export function deepProvider(requested: string | undefined, resolved: string | undefined, apiKey: string | undefined): string {
    if (apiKey) return resolved || 'claude';
    if (requested && !KEYLESS.has(requested.toLowerCase())) {
        throw new UsageError(`--provider ${requested} needs an API key: set RIGOUR_API_KEY (a CI secret), pass -k, or run \`rigour settings set-key ${requested} <key>\`. Use --provider local for the built-in local model.`);
    }
    return 'local';
}
