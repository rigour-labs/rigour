import { describe, it, expect, vi } from 'vitest';
import { FileScanner } from './scanner.js';
import { globby } from 'globby';

vi.mock('globby', async (importOriginal) => ({
    isDynamicPattern: (await importOriginal<typeof import('globby')>()).isDynamicPattern,
    globby: vi.fn(),
}));

describe('FileScanner', () => {
    it('should merge default ignores with user ignores', async () => {
        const options = {
            cwd: '/test',
            ignore: ['custom-ignore']
        };

        await FileScanner.findFiles(options);

        const call = vi.mocked(globby).mock.calls[0];
        const ignore = (call[1] as any).ignore;

        expect(ignore).toContain('**/node_modules/**');
        expect(ignore).toContain('custom-ignore');
    });

    it('should normalize Windows paths to forward slashes', async () => {
        const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
        Object.defineProperty(process, 'platform', { value: 'win32' });
        try {
            await FileScanner.findFiles({ cwd: 'C:\\test\\path', patterns: ['**\\*.ts', 'app\\\\[key\\]\\route.ts'] });
        } finally {
            Object.defineProperty(process, 'platform', platform);
        }

        const call = vi.mocked(globby).mock.calls.at(-1)!;
        expect(call[0]).toEqual(['**/*.ts', 'app/\\[key\\]/route.ts']);
        expect(call[1]?.cwd).toBe('C:/test/path');
    });

    it('should keep glob escapes on POSIX', async () => {
        const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
        Object.defineProperty(process, 'platform', { value: 'linux' });
        try {
            await FileScanner.findFiles({ cwd: '/repo', patterns: ['src/app/\\[key\\]/route.ts'] });
        } finally {
            Object.defineProperty(process, 'platform', platform);
        }

        expect(vi.mocked(globby).mock.calls.at(-1)![0]).toEqual(['src/app/\\[key\\]/route.ts']);
    });
});
