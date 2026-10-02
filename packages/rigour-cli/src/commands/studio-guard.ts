import { randomBytes, timingSafeEqual } from 'crypto';
import type { IncomingMessage } from 'http';

/** Header the Studio UI sends on every write, carrying the key from the launch link. */
export const STUDIO_KEY_HEADER = 'x-rigour-studio-key';

export interface StudioGuard {
    /** Host headers Studio answers to: loopback names on its own ports, nothing else. */
    allowedHosts: Set<string>;
    allowedOrigins: Set<string>;
    /** Per-launch secret, shown only in the link printed to the terminal that started Studio. */
    launchKey: string;
}

export function createStudioGuard(ports: Array<string | number>): StudioGuard {
    const allowedHosts = new Set<string>();
    const allowedOrigins = new Set<string>();
    for (const port of ports) {
        for (const host of ['127.0.0.1', 'localhost']) {
            allowedHosts.add(`${host}:${port}`);
            allowedOrigins.add(`http://${host}:${port}`);
        }
    }
    return { allowedHosts, allowedOrigins, launchKey: randomBytes(24).toString('hex') };
}

/** The link to open: the key rides in the fragment, which browsers never send to a server. */
export function studioLaunchUrl(base: string, guard: StudioGuard): string {
    return `${base}/#key=${guard.launchKey}`;
}

const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Why an API request must be refused, or null to serve it.
 * - A foreign Host is a DNS-rebinding page: refused for reads too, since reads return repository files.
 * - A write needs an allowed (or absent) Origin and the launch key. The custom header also forces a
 *   CORS preflight, so a cross-site form or text/plain POST never reaches a handler.
 */
export function refuseStudioRequest(req: Pick<IncomingMessage, 'headers' | 'method'>, guard: StudioGuard): string | null {
    const host = req.headers.host;
    if (!host || !guard.allowedHosts.has(host)) return 'unknown host';
    if (READS.has(req.method ?? 'GET')) return null;
    const origin = req.headers.origin;
    if (typeof origin === 'string' && !guard.allowedOrigins.has(origin)) return 'cross-origin write';
    const given = req.headers[STUDIO_KEY_HEADER];
    if (typeof given !== 'string') return 'missing studio key: open Studio from the link printed in your terminal';
    const a = Buffer.from(given);
    const b = Buffer.from(guard.launchKey);
    return a.length === b.length && timingSafeEqual(a, b) ? null : 'wrong studio key: open Studio from the link printed in your terminal';
}
