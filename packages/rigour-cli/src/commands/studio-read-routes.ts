/**
 * Studio's read-only pages: each GET path and the loader behind it. A loader reads what Rigour already records in this
 * repository (its checkouts' .rigour folders, the git folder, the local store) and never writes.
 */
import type { ServerResponse } from 'http';

type Loader = (cwd: string, url: URL) => unknown | Promise<unknown>;

const ROUTES: Record<string, () => Promise<Loader>> = {
    '/api/pulls': async () => (await import('./studio-pulls.js')).loadPulls,
    '/api/pull': async () => (await import('./studio-pulls.js')).loadPull,
};

/** Answers a GET for one of the read-only pages; false for any other path. */
export async function serveReadRoute(
    method: string | undefined,
    url: URL,
    cwd: string,
    res: ServerResponse,
    sendJson: (res: ServerResponse, status: number, body: unknown) => void,
): Promise<boolean> {
    const route = method === 'GET' ? ROUTES[url.pathname] : undefined;
    if (!route) return false;
    try {
        sendJson(res, 200, await (await route())(cwd, url));
    } catch (e: unknown) {
        sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
    return true;
}
