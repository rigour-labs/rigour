import type { DependencyGraph } from '../context/dependency-graph.js';
import type { LessonRecord } from '../storage/lessons.js';
import type { AgentHistoryEvent, AgentRun } from './agent-history.js';

export type KnowledgeNodeType = 'repository' | 'file' | 'agent' | 'task' | 'run' | 'advice' | 'pattern' | 'memory' | 'lesson' | 'policy' | 'outcome';

export interface KnowledgeNode {
    id: string;
    type: KnowledgeNodeType;
    label: string;
    detail?: string;
    state?: string;
    repositoryId?: string;
    weight: number;
    evidence?: Record<string, unknown>;
}

export interface KnowledgeEdge {
    id: string;
    from: string;
    to: string;
    type: 'contains' | 'imports' | 'performed' | 'belongs_to' | 'touched' | 'produced' | 'resulted_in' | 'defined_in' | 'protects' | 'remembered' | 'guided' | 'informed';
}

export interface EngineeringKnowledgeGraph {
    schemaVersion: 1;
    generatedAt: string;
    nodes: KnowledgeNode[];
    edges: KnowledgeEdge[];
    truncated: boolean;
    counts: Record<string, number>;
}

interface GraphInput {
    repository: { id: string; name: string };
    dependencyGraph?: DependencyGraph | null;
    events: AgentHistoryEvent[];
    runs: AgentRun[];
    lessons: LessonRecord[];
    patterns?: Array<{ id: string; name: string; type: string; file: string; description?: string; usageCount?: number }>;
    memories?: Array<{ id: string; label: string; detail?: string; source?: string }>;
    maxFiles?: number;
}

function shortPath(value: string): string {
    const parts = value.split('/');
    return parts.length > 3 ? `…/${parts.slice(-3).join('/')}` : value;
}

function shortLabel(value: string, limit = 72): string {
    return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

export function buildEngineeringKnowledgeGraph(input: GraphInput): EngineeringKnowledgeGraph {
    const nodes = new Map<string, KnowledgeNode>();
    const edges = new Map<string, KnowledgeEdge>();
    const addNode = (node: KnowledgeNode) => nodes.set(node.id, node);
    const addEdge = (from: string, to: string, type: KnowledgeEdge['type']) => {
        const id = `${type}:${from}:${to}`;
        edges.set(id, { id, from, to, type });
    };
    const repoId = `repository:${input.repository.id}`;
    addNode({ id: repoId, type: 'repository', label: input.repository.name, detail: input.repository.id, repositoryId: input.repository.id, weight: 10 });

    const eventFiles = new Set(input.events.flatMap(event => event.files));
    const graph = input.dependencyGraph;
    const degree = new Map<string, number>();
    for (const edge of graph?.edges ?? []) {
        degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
        degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
    }
    const maxFiles = input.maxFiles ?? 180;
    const selectedFiles = [...(graph?.nodes ?? [])]
        .sort((a, b) => Number(eventFiles.has(b)) - Number(eventFiles.has(a)) || (degree.get(b) ?? 0) - (degree.get(a) ?? 0))
        .slice(0, maxFiles);
    const selected = new Set(selectedFiles);
    for (const file of selectedFiles) {
        const id = `file:${file}`;
        addNode({ id, type: 'file', label: shortPath(file), detail: file, repositoryId: input.repository.id, weight: Math.min(8, 1 + (degree.get(file) ?? 0)) });
        addEdge(repoId, id, 'contains');
    }
    for (const edge of graph?.edges ?? []) {
        if (selected.has(edge.from) && selected.has(edge.to)) addEdge(`file:${edge.from}`, `file:${edge.to}`, 'imports');
    }

    for (const run of input.runs.slice(0, 100)) {
        const agentId = `agent:${run.agentId}`;
        const runId = `run:${run.id}`;
        addNode({ id: agentId, type: 'agent', label: run.agentId, weight: 5 });
        addNode({ id: runId, type: 'run', label: run.taskId ?? run.id, detail: `${run.eventCount} events`, state: run.status, weight: 4 });
        addEdge(agentId, runId, 'performed');
        addEdge(runId, repoId, 'belongs_to');
        if (run.taskId) {
            const taskId = `task:${run.taskId}`;
            addNode({ id: taskId, type: 'task', label: run.taskId, weight: 4 });
            addEdge(runId, taskId, 'belongs_to');
        }
        for (const file of run.files) if (selected.has(file)) addEdge(runId, `file:${file}`, 'touched');
        if (run.status !== 'active' && run.status !== 'unknown') {
            const outcomeId = `outcome:${run.id}:${run.status}`;
            addNode({ id: outcomeId, type: 'outcome', label: run.status, state: run.status, weight: 3 });
            addEdge(runId, outcomeId, 'resulted_in');
        }
    }

    for (const lesson of input.lessons.slice(0, 150)) {
        const lessonId = `lesson:${lesson.id}`;
        addNode({
            id: lessonId,
            type: 'lesson',
            label: lesson.subject,
            detail: `${lesson.visibility} · ${lesson.state} · ${Math.round(lesson.confidence * 100)}%`,
            state: lesson.state,
            repositoryId: lesson.repositoryId,
            weight: 4,
        });
        const sourceRepo = lesson.repositoryId === input.repository.id ? repoId : `repository:${lesson.repositoryId}`;
        if (!nodes.has(sourceRepo)) addNode({ id: sourceRepo, type: 'repository', label: lesson.repositoryName ?? `Repository ${lesson.repositoryId.slice(0, 8)}`, detail: lesson.repositoryId, repositoryId: lesson.repositoryId, weight: 7 });
        addEdge(sourceRepo, lessonId, 'produced');
    }

    for (const pattern of [...(input.patterns ?? [])]
        .sort((a, b) => (b.usageCount ?? 0) - (a.usageCount ?? 0))
        .slice(0, 120)) {
        const patternId = `pattern:${pattern.id}`;
        addNode({
            id: patternId,
            type: 'pattern',
            label: pattern.name,
            detail: `${pattern.type} · ${pattern.description || pattern.file}`,
            repositoryId: input.repository.id,
            weight: Math.min(8, 2 + Math.sqrt((pattern.usageCount ?? 0) + 1)),
        });
        const fileId = `file:${pattern.file}`;
        addEdge(nodes.has(fileId) ? fileId : repoId, patternId, nodes.has(fileId) ? 'defined_in' : 'contains');
    }

    for (const memory of (input.memories ?? []).slice(0, 100)) {
        const memoryId = `memory:${memory.id}`;
        addNode({
            id: memoryId,
            type: 'memory',
            label: memory.label,
            detail: `${memory.source ?? 'local'} · ${memory.detail ?? 'retained memory'}`,
            repositoryId: input.repository.id,
            weight: 3,
        });
        addEdge(repoId, memoryId, 'remembered');
    }

    for (const event of input.events) {
        if (!event.guidance) continue;
        const day = event.timestamp.slice(0, 10);
        const runKey = event.sessionId ?? event.taskId ?? event.requestId ?? `${event.agentId}:${day}`;
        const runId = `run:${runKey}`;
        if (!nodes.has(runId)) continue;
        const adviceId = `advice:${event.requestId ?? event.id}`;
        const telemetry = event.telemetry;
        const avoidedTokens = Math.max(0, (telemetry?.candidateTokens ?? 0) - (telemetry?.returnedTokens ?? 0));
        const knowledgeItems = event.guidance.patternRefs.length + event.guidance.lessonRefs.length + event.guidance.memoryRefs.length;
        addNode({
            id: adviceId,
            type: 'advice',
            label: shortLabel(event.guidance.recommendation),
            detail: `${event.guidance.kind} · ${knowledgeItems} knowledge items · ${avoidedTokens} tokens avoided`,
            state: telemetry?.classification ?? 'measured estimate',
            repositoryId: input.repository.id,
            weight: Math.min(8, 3 + Math.sqrt(knowledgeItems + 1)),
            evidence: {
                recommendation: event.guidance.recommendation,
                candidateTokens: telemetry?.candidateTokens ?? 0,
                returnedTokens: telemetry?.returnedTokens ?? 0,
                avoidedTokens,
                candidateFiles: telemetry?.candidateFiles ?? 0,
                returnedFiles: telemetry?.returnedFiles ?? 0,
                excludedFiles: event.guidance.excludedFileCount,
                cacheStatus: telemetry?.cacheStatus ?? 'none',
                classification: telemetry?.classification ?? 'measured estimate',
            },
        });
        addEdge(runId, adviceId, 'guided');
        for (const reference of event.guidance.patternRefs) {
            const sourceId = `pattern:${reference.id}`;
            if (nodes.has(sourceId)) addEdge(sourceId, adviceId, 'informed');
        }
        for (const reference of event.guidance.lessonRefs) {
            const sourceId = `lesson:${reference.id}`;
            if (nodes.has(sourceId)) addEdge(sourceId, adviceId, 'informed');
        }
        for (const reference of event.guidance.memoryRefs) {
            const sourceId = `memory:${reference.id}`;
            if (nodes.has(sourceId)) addEdge(sourceId, adviceId, 'informed');
        }
    }

    const prevented = input.events.filter(event => event.outcome === 'rejected');
    if (prevented.length > 0) {
        const policyId = 'policy:rigour-firewall';
        const outcomeId = 'outcome:prevented-actions';
        addNode({ id: policyId, type: 'policy', label: 'Rigour transaction firewall', detail: 'Deterministic mediation boundary', state: 'active', weight: 8 });
        addNode({ id: outcomeId, type: 'outcome', label: `${prevented.length} prevented actions`, detail: 'Rejected before unsafe execution', state: 'verified', weight: Math.min(10, 4 + prevented.length) });
        addEdge(policyId, repoId, 'protects');
        addEdge(policyId, outcomeId, 'produced');
    }

    const counts = [...nodes.values()].reduce<Record<string, number>>((result, node) => {
        result[node.type] = (result[node.type] ?? 0) + 1;
        return result;
    }, {});
    return {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        nodes: [...nodes.values()],
        edges: [...edges.values()],
        truncated: (graph?.nodes.length ?? 0) > selectedFiles.length
            || input.runs.length > 100
            || input.lessons.length > 150
            || (input.patterns?.length ?? 0) > 120
            || (input.memories?.length ?? 0) > 100,
        counts,
    };
}
