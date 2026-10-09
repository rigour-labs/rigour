/** Specialist v1: every earlier human review point (prompt step 1). A new version is a new file; the record names the version. */
export const PRIOR_POINTS_V1 = {
    id: 'prior-points',
    version: 1,
    title: 'earlier human review points',
    steps: [1],
    classes: [] as string[],
    focus: 'Judge every point of every human review as step 1 asks, siblings included. Report findings only when a point is unresolved and you can show it; leave every other list empty.',
};
