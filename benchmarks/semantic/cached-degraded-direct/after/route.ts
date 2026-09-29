declare function fetchRates(): Promise<Record<string, number>>;

async function ratesOrDefault(): Promise<Record<string, number> | null> {
  try {
    return await fetchRates();
  } catch {
    return null;
  }
}

export async function GET(): Promise<Response> {
  const rates = await ratesOrDefault();
  return new Response(JSON.stringify({ rates: rates ?? {} }), { headers: { 'Cache-Control': rates ? 'public, max-age=3600' : 'no-store' } });
}
