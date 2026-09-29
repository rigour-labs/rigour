interface Page { items: string[]; next?: string }
declare function listEvents(opts: { cursor?: string }): Promise<Page>;

export async function countEvents(): Promise<number> {
  const all: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await listEvents({ cursor });
    all.push(...page.items);
    cursor = page.next;
  } while (cursor);
  return all.length;
}
