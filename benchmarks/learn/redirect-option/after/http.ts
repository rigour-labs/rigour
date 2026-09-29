export async function postWithRetry(url: string, init: RequestInit): Promise<Response> {
  let last: Response | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    last = await fetch(url, { ...init, redirect: 'manual' });
    if (last.status < 500) return last;
  }
  return last!;
}
