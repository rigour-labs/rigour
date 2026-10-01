import { describe, expect, it } from 'vitest';
import { typeOnlySpecifiers, typesPackageFor } from './js-resolver.js';

describe('type-only imports', () => {
    it('finds specifiers imported only for types, and everything in a .d.ts file', () => {
        const ts = "import type { Context } from 'aws-lambda';\nimport { handler } from 'aws-lambda';\nexport type { Ev } from 'events-lib';\n";
        expect([...typeOnlySpecifiers(ts, 'src/a.ts')]).toEqual(['aws-lambda', 'events-lib']);
        const dts = "import type { Writable } from 'node:stream';\nimport { Context } from 'aws-lambda';\ntype X = import('express').Request;\n";
        expect([...typeOnlySpecifiers(dts, 'src/global.d.ts')]).toEqual(['node:stream', 'aws-lambda', 'express']);
    });

    it('names the DefinitelyTyped package, scoped ones included', () => {
        expect(typesPackageFor('aws-lambda')).toBe('@types/aws-lambda');
        expect(typesPackageFor('@babel/core')).toBe('@types/babel__core');
    });
});
