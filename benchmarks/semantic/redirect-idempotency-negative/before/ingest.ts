export async function ingest(endpoint: string, idempotencyKey: string, payload: string) {
  return fetch(endpoint, {
    method: 'POST',
    headers: { 'x-idempotency-key': idempotencyKey, 'x-request-id': idempotencyKey },
    body: payload,
  });
}
