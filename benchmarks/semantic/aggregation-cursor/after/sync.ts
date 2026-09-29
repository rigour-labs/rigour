interface Page { items: string[]; next?: string }
declare function listEvents(opts: { cursor?: string }): Promise<Page>;

export async function countEvents(): Promise<number> {
  let total = 0;
  let cursor: string | undefined;
  do {
    const page = await listEvents({ cursor });
    total += page.items.length;
    cursor = page.next;
  } while (cursor);
  return total;
}
