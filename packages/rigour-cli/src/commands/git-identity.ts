import { personOf } from '@rigour-labs/core';

/** Every decision path refuses with this: a decision recorded as nobody would never reach the team. */
const NO_GIT_EMAIL = 'no git email is set in this checkout (git config user.email)';

/** Who a person's decision is recorded as: their git email in the checkout, the one the team sync matches. Throws without one. */
export function decider(cwd: string): string {
    const by = personOf(cwd);
    if (by === 'unknown') throw new Error(NO_GIT_EMAIL);
    return by;
}
