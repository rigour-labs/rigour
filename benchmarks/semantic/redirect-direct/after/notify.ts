export async function notify(endpoint: string, signature: string, payload: string) {
  return fetch(endpoint, {
    method: 'POST',
    headers: { 'x-hook-signature': signature },
    body: payload,
    redirect: 'error',
  });
}
