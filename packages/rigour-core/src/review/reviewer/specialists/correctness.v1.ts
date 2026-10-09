/** Specialist v1: correctness past the request (prompt steps 5, 6, 7 and the correctness part of 11). */
export const CORRECTNESS_V1 = {
    id: 'correctness',
    version: 1,
    title: 'correctness: merge impact, the journey past the request, sibling parity',
    steps: [5, 6, 7, 11],
    classes: ['correctness'],
    focus: 'Trace what the change does to state that outlives the request: retries, two runs at once, statuses that can move back, keys that change on edit, and every sibling that needs the same change. Report only correctness findings.',
};
