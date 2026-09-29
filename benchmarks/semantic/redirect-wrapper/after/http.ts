export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Retries 5xx responses; callers own the error message. */
export async function sendWithRetry(fetch: FetchLike, url: string, init: RequestInit): Promise<Response> {
  let last: Response | undefined;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    last = await fetch(url, { ...init, redirect: 'manual' });
    if (last.status < 500) return last;
  }
  return last!;
}
