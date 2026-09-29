declare function loadTotals(id: string): Promise<{ total: number }>;
declare function loadBreakdown(id: string): Promise<{ rows: string[] }>;

async function breakdownOrNull(id: string) {
  try {
    return await loadBreakdown(id);
  } catch {
    return null;
  }
}

export async function dashboard(id: string) {
  const [totals, breakdown] = await Promise.all([loadTotals(id), breakdownOrNull(id)]);
  return { totals, rows: breakdown?.rows ?? [], complete: breakdown !== null };
}
