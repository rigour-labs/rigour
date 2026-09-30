import { describe, expect, it } from 'vitest';
import { parseDiff, removedByFile } from './diff.js';

const DIFF = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,5 +1,4 @@
 export function load(id: string) {
-  if (!id) return null;
-  audit(id);
+  audit(id ?? '');
   return fetch(id);
 }
@@ -20,2 +19,1 @@
-const legacy = true;
 export const x = 1;
`;

describe('removedByFile', () => {
    it('groups removed lines into blocks anchored at the new-side line', () => {
        expect(removedByFile(DIFF)).toEqual({
            'src/a.ts': [
                { line: 2, text: ['  if (!id) return null;', '  audit(id);'] },
                { line: 19, text: ['const legacy = true;'] },
            ],
        });
    });

    it('leaves added-line parsing unchanged', () => {
        expect([...parseDiff(DIFF)['src/a.ts']]).toEqual([2]);
    });
});
