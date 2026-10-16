/**
 * Studio's "Governance": is every agent covered, which rules hold, who decided what and why, and what the reviewer
 * used. Read only, from what Rigour already records: the agents' hook configs, the threads and event logs, the
 * decision stores, rigour.yml, the score history, the reviewer's store and the team's cache. Nothing is estimated;
 * what is not recorded is null, and the page says so.
 */
import fs from 'fs';
import path from 'path';
import { ConfigSchema, readCompiledChecks, readDeepRuns, readTeamAccess, refusedChanges, readTeamDecisionCache, type Config, type TeamAccess, type TeamDecisionCache } from '@rigour-labs/core';
import { agentHookConfigs, checkRepoSetup } from './repo-setup.js';
import { pushHookTarget } from './hooks-git.js';
import { reportOnly } from './report-only.js';
import { loadConfig } from './review-config.js';
import { checkoutRoots, eventsAcross } from './studio-checkouts.js';
import { buildCoverage, type Coverage } from './studio-governance-coverage.js';
import { buildDecisions, byPerson, readReviewDismissals, readStoredReviewLessons, type Decision } from './studio-governance-decisions.js';
import { buildQualityGates, readScores, type QualityGates } from './studio-governance-gates.js';
import { reviewerUsage, teamState, type ReviewerUsage, type TeamState } from './studio-governance-usage.js';
import { gitCommonDir, threadEvents } from './studio-threads.js';
import { readDismissals } from './studio-week.js';

const MAX_DECISIONS = 100;
const WINDOW_MS = 28 * 24 * 60 * 60 * 1000;

export interface StudioGovernance {
    coverage: Coverage;
    /** Setup's fixes for what is missing or broken, for the coverage card to point at. */
    fixes: Array<{ name: string; state: string; fix: string }>;
    decisions: Decision[];
    /** Decisions people made in the last 28 days: a command that timed out unanswered is not one. */
    decisionsRecent: number;
    qualityGates: QualityGates;
    reviewer: ReviewerUsage;
    team: TeamState;
}

/** What the team settings file says; injected in tests, read from the machine otherwise. */
export interface GovernanceDeps {
    teamConfig?: () => Promise<{ organizationId: string; teamId: string; actorId: string } | null>;
    teamCache?: (cwd: string) => TeamDecisionCache | undefined;
    teamAccess?: (scope: { organizationId: string; teamId: string; actorId: string }) => Promise<TeamAccess | undefined>;
    teamRefused?: (since: number) => Promise<{ count: number; latest?: string }>;
}

/** The route passes the request's URL second; nothing in it changes the page. `now` and `deps` are for tests. */
export async function loadGovernance(cwd: string, _url?: URL, now = new Date(), deps: GovernanceDeps = {}): Promise<StudioGovernance> {
    const roots = checkoutRoots(cwd);
    const common = gitCommonDir(cwd);
    const threads = threadEvents(common);
    const events = eventsAcross(roots);
    const config = await loadConfig(cwd, {}).catch(() => undefined);
    const checks = await checkRepoSetup(cwd, now, []);
    const teamCache = (deps.teamCache ?? readTeamDecisionCache)(cwd);
    const teamConfig = await (deps.teamConfig ?? defaultTeamConfig)().catch(() => null);
    const decisions = buildDecisions({
        lessons: readStoredReviewLessons(cwd), dismissals: readDismissals(cwd), reviewDismissals: readReviewDismissals(cwd),
        compiled: readCompiledChecks(cwd), events, team: teamCache,
    });
    const parsed = config ?? ConfigSchema.parse({});
    return {
        coverage: buildCoverage({
            now, agents: agentHookConfigs(cwd), codex: codexHere(cwd), pushGate: pushGateHere(cwd),
            prReviewer: prReviewerState(checks), threads, events,
        }),
        fixes: checks.filter(c => c.fix && (c.state === 'missing' || c.state === 'broken')).map(c => ({ name: c.name, state: c.state, fix: c.fix! })),
        decisions: decisions.slice(0, MAX_DECISIONS),
        decisionsRecent: decisions.filter(d => byPerson(d) && now.getTime() - Date.parse(d.at) <= WINDOW_MS).length,
        qualityGates: gates(cwd, { now, config: parsed, parsedFile: config !== undefined, scores: readScores(roots), threads }),
        reviewer: reviewerUsage(common && path.join(common, 'rigour-reviewer'), roots.flatMap(readDeepRuns), parsed, now),
        team: teamConfig
            ? teamState(teamConfig, teamCache, await (deps.teamAccess ?? readTeamAccess)(teamConfig).catch(() => undefined), await (deps.teamRefused ?? refusedChanges)(now.getTime() - WINDOW_MS).catch(() => undefined))
            : teamState(null, teamCache),
    };
}

function gates(cwd: string, input: Omit<Parameters<typeof buildQualityGates>[0], 'configFile' | 'personalReportOnly'> & { config: Config; parsedFile: boolean }): QualityGates {
    const { parsedFile, ...rest } = input;
    const exists = fs.existsSync(path.join(cwd, 'rigour.yml'));
    const configFile = !exists ? null : parsedFile ? 'rigour.yml' : 'rigour.yml (it does not parse: these are the defaults)';
    // The person's switch is read only when the team's file says nothing, so its warning about a team floor never prints.
    const personal = rest.config.hooks?.report_only === undefined && reportOnly(cwd);
    return buildQualityGates({ ...rest, configFile, personalReportOnly: personal });
}

/** The pull-request reviewer as setup found it: a check setup says is broken shows as broken, not on. */
function prReviewerState(checks: Array<{ id: string; state: string }>): 'on' | 'off' | 'broken' {
    const pr = checks.find(c => c.id === 'pr');
    if (!pr || pr.state === 'missing') return 'off';
    return pr.state === 'broken' ? 'broken' : 'on';
}

/** Codex reads AGENTS.md (init.ts detects it the same way) or its own folder; it runs no hooks. */
function codexHere(cwd: string): boolean {
    return fs.existsSync(path.join(cwd, 'AGENTS.md')) || fs.existsSync(path.join(cwd, '.codex'));
}

/** Whether git's pre-push hook runs Rigour's push gate, for every agent and the terminal alike. */
function pushGateHere(cwd: string): boolean {
    const target = pushHookTarget(cwd);
    if (!target || target.managed === 'outside') return false;
    try {
        return fs.readFileSync(target.file, 'utf8').includes('hooks push --git');
    } catch {
        return false;
    }
}

async function defaultTeamConfig() {
    const config = await (await import('@rigour-labs/core')).loadTeamConfiguration();
    return config ? { organizationId: config.organizationId, teamId: config.teamId, actorId: config.actorId } : null;
}
