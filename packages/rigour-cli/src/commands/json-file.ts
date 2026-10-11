/**
 * A JSON config Rigour writes into someone's repository or home, in that file's own style: the indent of its first
 * indented line (spaces or a tab), and 2 spaces for a file Rigour creates, so a formatter that checks JSON stays green.
 */

/** The indent a JSON file uses: from its first indented line; 2 spaces when it has none or there is no file yet. */
export function jsonIndent(existing?: string): string | number {
    return existing?.match(/\n([ \t]+)\S/)?.[1] ?? 2;
}

/** The JSON text for `value`, indented as `existing` is (2 spaces for a new file), ending with a newline. */
export function jsonText(value: unknown, existing?: string): string {
    return `${JSON.stringify(value, null, jsonIndent(existing))}\n`;
}
