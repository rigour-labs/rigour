/**
 * Studio's "Agent context": what Rigour put in front of agents before they wrote. Focused file
 * lists instead of the whole repository, lessons and memories recalled, and existing code an agent
 * was pointed to instead of writing it again. Token figures are Rigour's own estimate of the files
 * it considered and returned, said as such.
 */
import { getContextEvents, type AgentEvent, type ContextEvent } from '@rigour-labs/core';
import { checkoutRoots, eventsAcross } from './studio-checkouts.js';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const WEEKS = 8;
const SCOPE_TOOL = 'rigour_context_scope';

export interface StudioContextWeek { from: string; scopes: number; filesReturned: number; filesConsidered: number; recalls: number; lessonsTold: number; reuse: number }

export interface StudioAgentContext {
    week: {
        scopes: number;
        filesConsidered: number;
        filesReturned: number;
        /** Estimated tokens in what was considered and what was returned. */
        tokensConsidered: number;
        tokensReturned: number;
        recalls: number;
        lessonsTold: number;
        reuse: Array<{ at: string; planned: string; existing: string; action: string }>;
    };
    weeks: StudioContextWeek[];
}

export function buildAgentContext(input: { now: Date; context: ContextEvent[]; events: AgentEvent[] }): StudioAgentContext {
    const at = (e: ContextEvent) => e.createdAt ?? 0;
    const since = input.now.getTime() - WEEK_MS;
    const recentContext = input.context.filter(e => at(e) > since);
    const scopes = recentContext.filter(e => e.toolName === SCOPE_TOOL);
    const inWeek = (e: AgentEvent) => Date.parse(e.timestamp ?? '') > since;
    const served = input.events.filter(e => e.type === 'lessons_served');
    const reuse = input.events.filter(e => e.type === 'reuse_suggested');
    const sum = (list: ContextEvent[], pick: (e: ContextEvent) => number | undefined) => list.reduce((n, e) => n + (pick(e) ?? 0), 0);
    return {
        week: {
            scopes: scopes.length,
            filesConsidered: sum(scopes, e => e.candidateFiles),
            filesReturned: sum(scopes, e => e.returnedFiles),
            tokensConsidered: sum(scopes, e => e.candidateTokens),
            tokensReturned: sum(scopes, e => e.returnedTokens),
            recalls: recentContext.filter(e => e.toolName === 'rigour_recall').length,
            lessonsTold: served.filter(inWeek).reduce((n, e) => n + (e.lessons?.length ?? 0), 0),
            reuse: reuse.filter(inWeek).reverse().map(e => ({ at: e.timestamp ?? '', planned: e.planned ?? '', existing: e.existing ?? '', action: e.action ?? '' })),
        },
        weeks: Array.from({ length: WEEKS }, (_, i) => {
            const end = input.now.getTime() - (WEEKS - 1 - i) * WEEK_MS;
            const start = end - WEEK_MS;
            const within = (t: number) => t > start && t <= end;
            const weekScopes = input.context.filter(e => e.toolName === SCOPE_TOOL && within(at(e)));
            return {
                from: new Date(start).toISOString(),
                scopes: weekScopes.length,
                filesReturned: sum(weekScopes, e => e.returnedFiles),
                filesConsidered: sum(weekScopes, e => e.candidateFiles),
                recalls: input.context.filter(e => e.toolName === 'rigour_recall' && within(at(e))).length,
                lessonsTold: served.filter(e => within(Date.parse(e.timestamp ?? ''))).reduce((n, e) => n + (e.lessons?.length ?? 0), 0),
                reuse: reuse.filter(e => within(Date.parse(e.timestamp ?? ''))).length,
            };
        }),
    };
}

export async function loadAgentContext(cwd: string, now = new Date()): Promise<StudioAgentContext> {
    return buildAgentContext({ now, context: await getContextEvents(undefined, cwd), events: eventsAcross(checkoutRoots(cwd)) });
}
