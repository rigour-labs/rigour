declare function fetchCatalog(): Promise<string[]>;

export async function GET(): Promise<Response> {
  const items = await fetchCatalog();
  return Response.json({ items }, { headers: { 'cache-control': 'public, max-age=300' } });
}
