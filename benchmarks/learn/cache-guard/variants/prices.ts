declare function loadRates(): Promise<Record<string, number> | null>;

export async function prices(): Promise<Response> {
  const rates = await loadRates();
  return new Response(JSON.stringify({ rates }), { headers: { 'Cache-Control': 'max-age=60' } });
}

export async function guarded(): Promise<Response> {
  const rates = await loadRates();
  return new Response(JSON.stringify({ rates }), { headers: { 'Cache-Control': rates ? 'max-age=60' : 'no-store' } });
}

export function health(): Response {
  return new Response('ok', { headers: { 'Cache-Control': 'max-age=5' } });
}
