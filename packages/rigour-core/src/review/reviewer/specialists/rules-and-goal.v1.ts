/** Specialist v1: what this team and this pull request asked for (prompt steps 8, 9, 10 and 12). */
export const RULES_AND_GOAL_V1 = {
    id: 'rules-and-goal',
    version: 1,
    title: 'claims, team lessons, repository rules and the declared goal',
    steps: [8, 9, 10, 12],
    classes: ['stale-claim', 'repo-rule'],
    focus: 'Check every claim in a touched comment or the description, every team lesson served, every repository rule served (by id), and every declared goal item if the goal step is present. Report only stale-claim and repo-rule findings.',
};
