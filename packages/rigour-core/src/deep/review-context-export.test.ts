import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCodeReviewPrompt } from './code-review-prompt.js';
import { exportReviewContexts } from './review-context-export.js';

let dir: string | undefined;
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = undefined; });

const DIFF = `diff --git a/src/total.ts b/src/total.ts
--- a/src/total.ts
+++ b/src/total.ts
@@ -2,2 +2,2 @@
   let sum = 0;
-  for (let i = 0; i < items.length; i++) sum += items[i];
+  for (let i = 0; i <= items.length; i++) sum += items[i];
`;

describe('exportReviewContexts', () => {
    it('emits the review prompt for each changed file, with its focus lines and what the change removed', async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-context-'));
        fs.mkdirSync(path.join(dir, 'src'));
        fs.writeFileSync(path.join(dir, 'src/total.ts'), 'export function total(items: number[]) {\n  let sum = 0;\n  for (let i = 0; i <= items.length; i++) sum += items[i];\n  return sum;\n}\n');
        const [context, ...rest] = await exportReviewContexts(dir, DIFF, { prBody: 'Sum the basket.' });
        expect(rest).toEqual([]);
        expect(context.file).toBe('src/total.ts');
        expect(context.focusLines).toEqual([3]);
        expect(context.prompt.startsWith(buildCodeReviewPrompt({ file: '', language: '', text: '', ranges: [], source: '' }).slice(0, 60))).toBe(true);
        expect(context.prompt).toContain('3|   for (let i = 0; i <= items.length; i++) sum += items[i];');
        expect(context.prompt).toContain('-   for (let i = 0; i < items.length; i++) sum += items[i];');
        expect(context.prompt).toContain('Sum the basket.');
    });
});
