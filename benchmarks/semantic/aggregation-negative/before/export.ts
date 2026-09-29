interface Page { rows: string[]; next?: string }
declare function listRows(opts: { cursor?: string }): Promise<Page>;

export async function exportRows(): Promise<string[]> {
  const rows: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await listRows({ cursor });
    rows.push(...page.rows);
    cursor = page.next;
  } while (cursor);
  return rows;
}
