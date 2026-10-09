import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InconsistentErrorHandlingGate } from './inconsistent-error-handling.js';

describe('InconsistentErrorHandlingGate', () => {
    let cwd: string;
    beforeEach(() => { cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'error-handling-')); });
    afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

    /** Three Python files catching ValueError: one wraps it, one logs it, and the third does `third`. */
    async function strategies(third: string): Promise<string[]> {
        const files: Record<string, string> = {
            'app/a.py': 'def a(x):\n    try:\n        return int(x)\n    except ValueError as e:\n        raise AppError("bad input") from e\n',
            'app/b.py': 'import logging\n\ndef b(x):\n    try:\n        return int(x)\n    except ValueError as e:\n        logging.warning("bad input %s", e)\n',
            'app/c.py': `def c(x):\n    try:\n        return int(x)\n    except ValueError as e:\n        ${third}\n`,
        };
        for (const [file, body] of Object.entries(files)) {
            fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
            fs.writeFileSync(path.join(cwd, file), body);
        }
        const failures = await new InconsistentErrorHandlingGate().run({ cwd });
        return failures.map(f => f.details);
    }

    it('reads a handler that only hands the error to a helper as no strategy of its own', async () => {
        expect(await strategies('return handle_value_error(e)')).toEqual([]);
        expect(await strategies('report.value_error(x, e)')).toEqual([]);
    });

    it('still reports a third real strategy', async () => {
        expect(await strategies('return None')).toEqual([expect.stringContaining("Inconsistent error handling for 'except'")]);
    });
});
