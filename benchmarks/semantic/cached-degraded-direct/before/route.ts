declare function fetchRates(): Promise<Record<string, number>>;

async function ratesOrDefault(): Promise<Record<string, number>> {
  try {
    return await fetchRates();
  } catch {
    return {};
  }
}

export async function GET(): Promise<Response> {
  const rates = await ratesOrDefault();
  return new Response(JSON.stringify({ rates }), { headers: { 'Cache-Control': 'public, max-age=3600' } });
}
