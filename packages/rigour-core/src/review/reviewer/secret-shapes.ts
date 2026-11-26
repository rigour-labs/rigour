/**
 * Token shapes Rigour's secret scanner (hooks/input-validator.ts) does not know, used where a judge's answer is
 * redacted (redact.ts). Each is a provider's documented prefix with its length, so a match is the credential itself,
 * not a word that resembles one. The scanner the edit hooks use is unchanged.
 */
interface Shape { type: string; regex: RegExp }

const SHAPES: Shape[] = [
    { type: 'npm_token', regex: /\bnpm_[A-Za-z0-9]{36}\b/g },
    { type: 'google_api_key', regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
    { type: 'aws_temporary_key', regex: /\bASIA[0-9A-Z]{16}\b/g },
    { type: 'slack_webhook', regex: /https:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9/_-]{20,}/g },
    { type: 'slack_token', regex: /\bxox[abeoprs]-[A-Za-z0-9-]{10,}/g },
    { type: 'bearer_token', regex: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g },
    { type: 'gitlab_token', regex: /\bgl(?:pat|dt|rt|ptt|cbt|oas)-[A-Za-z0-9_-]{20,}/g },
    { type: 'pypi_token', regex: /\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,}/g },
    { type: 'huggingface_token', regex: /\bhf_[A-Za-z0-9]{34,}\b/g },
    { type: 'discord_webhook', regex: /https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]{30,}/g },
    { type: 'shopify_token', regex: /\bshp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}\b/g },
    { type: 'digitalocean_token', regex: /\bdo[opr]_v1_[a-f0-9]{64}\b/g },
    { type: 'doppler_token', regex: /\bdp\.(?:pt|st|sa|ct|scim|audit)\.[A-Za-z0-9]{40,}\b/g },
    { type: 'linear_key', regex: /\blin_api_[A-Za-z0-9]{40}\b/g },
    { type: 'postman_key', regex: /\bPMAK-[a-f0-9]{24}-[a-f0-9]{34}\b/g },
    { type: 'supabase_token', regex: /\bsbp_[a-f0-9]{40}\b/g },
    { type: 'stripe_webhook_secret', regex: /\bwhsec_[A-Za-z0-9]{32,}\b/g },
    { type: 'telegram_bot_token', regex: /\b\d{8,10}:AA[0-9A-Za-z_-]{33}\b/g },
    { type: 'groq_key', regex: /\bgsk_[A-Za-z0-9]{52}\b/g },
    { type: 'age_secret_key', regex: /\bAGE-SECRET-KEY-1[0-9A-Z]{58}\b/g },
    { type: 'mailgun_key', regex: /\bkey-[0-9a-f]{32}\b/g },
];

/** Every span of `text` a shape matches, with its kind. */
export function shapeMatches(text: string): Array<{ type: string; start: number; end: number }> {
    const found: Array<{ type: string; start: number; end: number }> = [];
    for (const { type, regex } of SHAPES) {
        regex.lastIndex = 0;
        for (let m = regex.exec(text); m; m = regex.exec(text)) found.push({ type, start: m.index, end: m.index + m[0].length });
    }
    return found;
}
