const KEY_STORAGE = 'rigour-studio-key';
const KEY_HEADER = 'x-rigour-studio-key';

/**
 * Take the launch key from the link the terminal printed (#key=…), keep it for this tab,
 * and drop it from the address bar so it is not copied or bookmarked.
 */
export function captureStudioKey(): void {
    const match = window.location.hash.match(/(?:^#|&)key=([a-f0-9]+)/);
    if (!match) return;
    try { sessionStorage.setItem(KEY_STORAGE, match[1]); } catch { /* storage blocked: writes will ask for the link */ }
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
}

function studioKey(): string {
    try { return sessionStorage.getItem(KEY_STORAGE) ?? ''; } catch { return ''; }
}

/** Every Studio write goes through here: the server refuses a write without the launch key. */
export function studioWrite(url: string, method: 'POST' | 'DELETE', body?: string, contentType = 'application/json'): Promise<Response> {
    const headers: Record<string, string> = { [KEY_HEADER]: studioKey() };
    if (body !== undefined) headers['Content-Type'] = contentType;
    return fetch(url, { method, headers, body });
}
