import React, { useCallback, useEffect, useState } from 'react';

export type CatchStage = 'edit' | 'review' | 'stop' | 'pr';

export interface Story {
    id: string;
    at: string;
    stage: CatchStage;
    file: string;
    rule: string;
    title: string;
    details?: string;
    diff: string[];
}

/** Where a problem was caught, in words a person uses. */
export const STAGE_WORDS: Record<CatchStage, string> = {
    edit: 'while the agent was writing',
    review: 'when the agent checked its work',
    stop: 'before the agent said done',
    pr: 'at the pull request',
};

export function ago(at: string, now = Date.now()): string {
    const minutes = Math.round((now - Date.parse(at)) / 60_000);
    if (!Number.isFinite(minutes)) return '';
    if (minutes < 60) return `${Math.max(1, minutes)} min ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${hours} h ago`;
    return new Date(at).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

export function plural(n: number, one: string, many = `${one}s`): string {
    return `${n} ${n === 1 ? one : many}`;
}

/**
 * GET a Studio endpoint; `reload` fetches again after a change. When the URL changes (a 7/28-day toggle), the previous
 * URL's data is not returned (data is null, so the page shows its loading state) and a late answer for it is ignored.
 */
export function useStudioJson<T>(url: string): { data: T | null; error: string | null; reload: () => void } {
    const [state, setState] = useState<{ url: string; data: T | null; error: string | null }>({ url, data: null, error: null });
    const [nonce, setNonce] = useState(0);
    useEffect(() => {
        let current = true;
        fetch(url)
            .then(async res => {
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = (await res.json()) as T;
                if (current) setState({ url, data, error: null });
            })
            .catch(err => {
                const error = err instanceof Error ? err.message : String(err);
                if (current) setState(prev => ({ url, data: prev.url === url ? prev.data : null, error }));
            });
        return () => { current = false; };
    }, [url, nonce]);
    const reload = useCallback(() => setNonce(n => n + 1), []);
    const fresh = state.url === url;
    return { data: fresh ? state.data : null, error: fresh ? state.error : null, reload };
}

/** Text with `code` spans, as Rigour writes findings and lessons: backticked parts render as code. */
export function inlineCode(text: string): React.ReactNode[] {
    return text.split(/(`[^`]+`)/g).map((part, i) =>
        part.startsWith('`') && part.endsWith('`') && part.length > 2
            ? React.createElement('code', { key: i, className: 'st-mono st-inline-code' }, part.slice(1, -1))
            : part);
}
