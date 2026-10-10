/** Who a person's decision is recorded as: their git email in the checkout, or `unknown` without one. */
import { execFileSync } from 'child_process';

export function personOf(cwd: string): string {
    try {
        return execFileSync('git', ['config', 'user.email'], { cwd, encoding: 'utf8' }).trim() || 'unknown';
    } catch {
        return 'unknown'; // no git identity: recorded as unknown
    }
}
