import { sendWithRetry, type FetchLike } from './http';

export async function pushBatch(fetch: FetchLike, target: string, token: string, events: unknown[]) {
  return sendWithRetry(fetch, `${target}/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-ingest-token': token },
    body: JSON.stringify(events),
  });
}
