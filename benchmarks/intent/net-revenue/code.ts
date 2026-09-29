declare function sumSales(month: string): Promise<number>;
declare function sumRefunds(month: string): Promise<number>;

/** Net revenue for the month: sales minus refunds, reported to finance. */
export async function netRevenue(month: string) {
  const [sales, refunds] = await Promise.all([sumSales(month), sumRefunds(month)]);
  return { month, net: sales - refunds };
}
