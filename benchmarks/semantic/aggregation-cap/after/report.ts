import { countByStatus } from './db';

export async function orderStatusCounts(db: unknown, since: string) {
  return countByStatus(db, 'orders', since);
}
