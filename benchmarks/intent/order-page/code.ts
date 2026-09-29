declare function getOrder(orderId: string): Promise<{ id: string; placedAt: string; status: string }>;
declare function getOrderLines(orderId: string): Promise<Array<{ sku: string; qty: number; price: number }>>;

/** The order detail page: the order and every line on it, with the total. */
export async function orderPage(orderId: string) {
  const [order, lines] = await Promise.all([getOrder(orderId), getOrderLines(orderId)]);
  const total = lines.reduce((sum, line) => sum + line.qty * line.price, 0);
  return { ...order, lines, total };
}
