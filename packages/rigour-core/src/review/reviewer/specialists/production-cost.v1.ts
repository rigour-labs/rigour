/** Specialist v1: production cost (prompt steps 3, 4 and the production-cost part of 11). */
export const PRODUCTION_COST_V1 = {
    id: 'production-cost',
    version: 1,
    title: 'production cost: every read and every nested scan',
    steps: [3, 4, 11],
    classes: ['production-cost'],
    focus: 'Trace every read the change adds or alters: rules known before it, a narrower source, bounded windows, keyset paging, the index that serves it, and any collection scanned once per item of another. Report only production-cost findings.',
};
