/**
 * Whether any index on a table can serve a read.
 *
 * The claim is deliberately narrow, so it can be proved from the schema
 * alone: no index starts with a column the read compares to a value or sorts
 * by first, or every index that does is partial with a WHERE the read's
 * filters do not satisfy. `IS NOT NULL` alone is not a comparison: it narrows
 * nothing on a mostly filled column. When a predicate cannot be read, the
 * index counts as serving, so doubt keeps the gate silent.
 */
import type { IndexDef, PredicateTerm } from './schema.js';
import type { Filter, Read } from './queries.js';

/** Columns the read narrows by value or orders by first (lower case). */
export function seekColumns(read: Read): Set<string> {
    const columns = new Set(read.filters.filter(f => f.op !== 'notnull').map(f => f.column.toLowerCase()));
    if (read.orderBy) columns.add(read.orderBy.toLowerCase());
    return columns;
}

export function servesRead(index: IndexDef, read: Read): boolean {
    if (index.leading === null || !seekColumns(read).has(index.leading.toLowerCase())) return false;
    return index.predicate.every(term => satisfied(term, read.filters));
}

/** Whether the read's filters satisfy one partial-index term; an unreadable term is assumed satisfied. */
function satisfied(term: PredicateTerm, filters: Filter[]): boolean {
    if (term.kind === 'unknown') return true;
    const own = filters.filter(f => f.column.toLowerCase() === term.column.toLowerCase());
    if (term.kind === 'null') return own.some(f => f.op === 'isnull');
    // Every operator but IS NULL is strict: a row it matches has a value, so it implies IS NOT NULL.
    if (term.kind === 'notnull') return own.some(f => f.op !== 'isnull');
    return own.some(f => f.op === 'eq' && (f.value === undefined || f.value === term.value)) || own.some(f => f.op === 'in' || f.op === 'match');
}
