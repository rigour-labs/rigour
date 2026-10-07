import { describe, expect, it } from 'vitest';
import { splitCommand } from './command-line.js';

describe('splitCommand', () => {
    it('splits on spaces and keeps a quoted argument whole, without its quotes', () => {
        expect(splitCommand('npm run lint')).toEqual({ bin: 'npm', args: ['run', 'lint'] });
        expect(splitCommand(`vitest run "src/a b.test.ts" --reporter 'dot'`)).toEqual({ bin: 'vitest', args: ['run', 'src/a b.test.ts', '--reporter', 'dot'] });
    });
});
