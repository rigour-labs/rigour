import React from 'react';
import { ControlsContainer, FullScreenControl, SigmaContainer, useRegisterEvents, useSetSettings, useSigma, ZoomControl } from '@react-sigma/core';
import { useWorkerLayoutForceAtlas2 } from '@react-sigma/layout-forceatlas2';
import type Graph from 'graphology';
import { EdgeLineProgram, NodeCircleProgram } from 'sigma/rendering';
import type { GraphData, GraphSelection } from './types';
import { createSigmaGraph, graphNeighbours } from './graph-model';
import '@react-sigma/core/lib/style.css';

interface Props {
    data: GraphData;
    selectedId: string | null;
    onSelect: (selection: GraphSelection | null) => void;
}

function GraphEvents({ data, selectedId, onSelect }: Props) {
    const sigma = useSigma();
    const registerEvents = useRegisterEvents();
    const setSettings = useSetSettings();
    const { start, stop, kill } = useWorkerLayoutForceAtlas2({ settings: { barnesHutOptimize: true, gravity: 0.08, scalingRatio: 8, slowDown: 5 } });

    React.useEffect(() => {
        registerEvents({
            clickNode: ({ node }) => {
                const selected = data.nodes.find(candidate => candidate.id === node);
                if (!selected) return;
                const neighbours = graphNeighbours(data, node);
                onSelect({ node: selected, neighbours, relationshipCount: neighbours.length });
            },
            clickStage: () => onSelect(null),
        });
    }, [data, onSelect, registerEvents]);

    React.useEffect(() => {
        const highlighted = new Set(selectedId ? [selectedId, ...graphNeighbours(data, selectedId).map(node => node.id)] : []);
        setSettings({
            nodeReducer: (node, attributes) => ({
                ...attributes,
                label: selectedId && !highlighted.has(node) ? '' : attributes.label,
                color: selectedId && !highlighted.has(node) ? 'rgba(100, 116, 139, 0.16)' : attributes.color,
                zIndex: highlighted.has(node) ? 2 : 1,
            }),
            edgeReducer: (edge, attributes) => {
                if (!selectedId) return attributes;
                const extremities = sigma.getGraph().extremities(edge);
                const connected = extremities.includes(selectedId);
                return { ...attributes, hidden: !connected, size: connected ? 1.8 : attributes.size };
            },
        });
        sigma.refresh();
    }, [data, selectedId, setSettings, sigma]);

    React.useEffect(() => {
        if (sigma.getGraph().order < 2) return undefined;
        start();
        const timer = window.setTimeout(stop, 1800);
        return () => { window.clearTimeout(timer); stop(); kill(); };
    }, [kill, sigma, start, stop]);

    return null;
}

export function ImpactGraphCanvas(props: Props) {
    const graph = React.useMemo(() => createSigmaGraph(props.data), [props.data]);
    const graphKey = React.useMemo(
        () => `${props.data.generatedAt}:${props.data.nodes.map(node => node.id).join('|')}`,
        [props.data],
    );
    const settings = React.useMemo(() => ({
        allowInvalidContainer: true,
        defaultNodeType: 'circle',
        nodeProgramClasses: { circle: NodeCircleProgram },
        defaultEdgeType: 'line',
        edgeProgramClasses: { line: EdgeLineProgram },
        labelDensity: 0.08,
        labelGridCellSize: 120,
        labelRenderedSizeThreshold: 7,
        minCameraRatio: 0.04,
        maxCameraRatio: 8,
        renderEdgeLabels: false,
        zIndex: true,
    }), []);

    return (
        <SigmaContainer key={graphKey} graph={graph as Graph} settings={settings} className="impact-sigma" style={{ height: '100%', width: '100%' }}>
            <GraphEvents {...props} />
            <ControlsContainer position="bottom-right">
                <ZoomControl />
                <FullScreenControl />
            </ControlsContainer>
        </SigmaContainer>
    );
}
