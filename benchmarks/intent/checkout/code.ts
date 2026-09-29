declare function getCart(sessionId: string): Promise<{ items: Array<{ sku: string; qty: number }> }>;
declare function quoteTax(sessionId: string): Promise<{ tax: number }>;
declare function quoteShipping(sessionId: string): Promise<{ shipping: number }>;

/** The amount charged at checkout. It must include tax and shipping. */
export async function checkoutTotal(sessionId: string, subtotal: number) {
  const [cart, tax, shipping] = await Promise.all([getCart(sessionId), quoteTax(sessionId), quoteShipping(sessionId)]);
  return { items: cart.items, charge: subtotal + tax.tax + shipping.shipping };
}
