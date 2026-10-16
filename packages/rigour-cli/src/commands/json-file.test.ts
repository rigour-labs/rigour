import { describe, expect, it } from 'vitest';
import { jsonText } from './json-file.js';

describe("a JSON config in the file's own style", () => {
    it('keeps the indent of the file it rewrites, and uses 2 spaces for a new one', () => {
        const value = { a: { b: 1 } };
        expect(jsonText(value, '{\n  "x": 1\n}\n')).toBe('{\n  "a": {\n    "b": 1\n  }\n}\n');
        expect(jsonText(value, '{\n    "x": 1\n}\n')).toBe('{\n    "a": {\n        "b": 1\n    }\n}\n');
        expect(jsonText(value, '{\n\t"x": 1\n}\n')).toBe('{\n\t"a": {\n\t\t"b": 1\n\t}\n}\n');
        expect(jsonText(value, '{"x":1}')).toBe('{\n  "a": {\n    "b": 1\n  }\n}\n'); // no indent to follow: 2 spaces
        expect(jsonText(value)).toBe('{\n  "a": {\n    "b": 1\n  }\n}\n'); // a new file: 2 spaces
    });

    it('re-pins a version by rewriting only that string, leaving the layout a formatter chose', () => {
        const before = '{\n  "mcpServers": {\n    "rigour": {\n      "command": "npx",\n      "args": ["-y", "@rigour-labs/mcp@7.0.10"]\n    },\n    "other": { "command": "x", "args": [] }\n  }\n}\n';
        const value = JSON.parse(before);
        value.mcpServers.rigour.args[1] = '@rigour-labs/mcp@7.0.11';
        expect(jsonText(value, before)).toBe(before.replace('7.0.10', '7.0.11'));
        expect(jsonText(JSON.parse(before), before)).toBe(before); // nothing changed: the file as it was
        expect(jsonText(JSON.parse('{"a":"x"}'), '{"a":"x"}')).toBe('{"a":"x"}\n');
        const escaped = '{\n  "path": "C:\\\\tools\\\\rigour",\n  "v": "1"\n}\n';
        expect(jsonText({ path: 'C:\\tools\\rigour', v: '2' }, escaped)).toBe(escaped.replace('"1"', '"2"'));
    });

    it('keeps a short array of plain values on one line when it writes the whole file', () => {
        const added = { mcpServers: { rigour: { command: 'npx', args: ['-y', '@rigour-labs/mcp@7.0.11'] } } };
        expect(jsonText(added, '{\n  "mcpServers": {}\n}\n')).toBe(
            '{\n  "mcpServers": {\n    "rigour": {\n      "command": "npx",\n      "args": ["-y", "@rigour-labs/mcp@7.0.11"]\n    }\n  }\n}\n',
        );
        const long = { args: Array.from({ length: 8 }, (_, i) => `--a-rather-long-flag-${i}`) };
        expect(jsonText(long)).toBe(`{\n  "args": [\n${long.args.map(a => `    "${a}"`).join(',\n')}\n  ]\n}\n`); // too wide: one per line
        const tabbed = { a: { b: { c: { d: { e: ['a'.repeat(30), 'b'.repeat(30)] } } } } }; // 75 columns counting a tab as 1, 80+ counting it as 2
        expect(jsonText(tabbed, '{\n\t"x": 1\n}\n')).toContain('"e": [\n'); // tabs count 2 columns, as Prettier counts them: too wide to join
        expect(jsonText({ a: '2' }, '{\r\n  "a": "1"\r\n}')).toBe('{\r\n  "a": "2"\r\n}\r\n');
        expect(jsonText({ hooks: [{ command: 'x' }] })).toBe('{\n  "hooks": [\n    {\n      "command": "x"\n    }\n  ]\n}\n'); // objects stay expanded
    });
});
