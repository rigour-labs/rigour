/** Specialist v1: what the change leaves behind (prompt step 2 and the dead-code, duplication and helper-bypass parts of 11). */
export const CLEANUP_V1 = {
    id: 'cleanup',
    version: 1,
    title: 'what the change leaves behind: redundancy, dead code, duplication, helpers bypassed',
    steps: [2, 11],
    classes: ['dead-code', 'duplication', 'helper-bypass'],
    focus: 'Find what a fix made unnecessary and whether it was removed, exports nothing consumes (a test is not a consumer), code copied across sibling routes or runners, and links or ids built outside the helper that owns them. Report only those classes.',
};
