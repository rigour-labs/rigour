/** Every count Studio shows, with the same thousands separators on every page; ui.tsx re-exports it. */
export function formatCount(n: number): string {
    return n.toLocaleString('en-US');
}
