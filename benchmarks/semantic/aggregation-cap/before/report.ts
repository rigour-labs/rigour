import { fetchAllRows } from './db';

type Order = { id: string; status: string };

export async function orderStatusCounts(db: unknown, since: string) {
  const orders: Order[] = [];
  orders.push(...await fetchAllRows<Order>(db, 'orders', since));
  if (orders.length > 50_000) throw new Error('report_too_large');
  const counts: Record<string, number> = {};
  for (const order of orders) counts[order.status] = (counts[order.status] ?? 0) + 1;
  return counts;
}
