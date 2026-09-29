async function loadRates(): Promise<Record<string, number> | null> {
  try {
    const res = await fetch('https://rates.example.com/v1/latest');
    return (await res.json()) as Record<string, number>;
  } catch {
    return null;
  }
}

export async function GET(): Promise<Response> {
  const rates = await loadRates();
  return new Response(JSON.stringify({ rates: rates ?? {} }), { headers: { 'Cache-Control': 'public, max-age=3600' } });
}
