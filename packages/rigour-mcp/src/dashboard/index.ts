/**
 * Dashboard Resource Serving
 *
 * Serves the MCP App dashboard as a ui:// resource.
 * Injects current DashboardState into the HTML on each fetch
 * so the client always gets the latest governance snapshot.
 */
import { DASHBOARD_HTML } from './html.js';
import { getState } from './state.js';

export const DASHBOARD_URI = "ui://rigour/dashboard";

/** Get dashboard HTML with current state injected. */
export function getDashboardHtml(): string {
    const stateJson = JSON.stringify(getState()).replace(/'/g, "\\'");
    return DASHBOARD_HTML.replace('__INITIAL_STATE__', stateJson);
}

export { getState, pushTimelineEntry, updateScore, updateBrainStatus, setScanning } from './state.js';
