/**
 * Dashboard HTML — Self-contained MCP App UI
 *
 * Served as a ui:// resource. Renders in a sandboxed iframe
 * inside Claude Desktop, VS Code Copilot, ChatGPT, Goose.
 *
 * Features:
 * - SVG circular score gauge (color-coded)
 * - Scrolling activity timeline
 * - Severity breakdown bar
 * - Brain learning indicator
 *
 * No external dependencies. Initial state injected via __INITIAL_STATE__.
 */

export const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Rigour Governance</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0d1117;color:#c9d1d9;padding:16px;font-size:13px;line-height:1.5}
.header{display:flex;align-items:center;gap:8px;margin-bottom:16px}
.header h1{font-size:15px;font-weight:600;color:#f0f6fc}
.header .badge{font-size:11px;padding:2px 8px;border-radius:12px;font-weight:500}
.badge-pass{background:#1a7f37;color:#fff}
.badge-fail{background:#da3633;color:#fff}
.badge-scanning{background:#9e6a03;color:#fff}
.badge-idle{background:#30363d;color:#8b949e}
.top{display:flex;gap:16px;margin-bottom:16px}
.gauge-wrap{flex:0 0 100px;text-align:center}
.gauge-label{font-size:11px;color:#8b949e;margin-top:4px}
.severity-wrap{flex:1;display:flex;flex-direction:column;justify-content:center;gap:6px}
.sev-row{display:flex;align-items:center;gap:6px;font-size:12px}
.sev-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.sev-critical{background:#da3633}
.sev-high{background:#db6d28}
.sev-medium{background:#9e6a03}
.sev-low{background:#388bfd}
.sev-info{background:#8b949e}
.sev-count{color:#f0f6fc;font-weight:600;min-width:18px}
.section-title{font-size:11px;color:#8b949e;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px;font-weight:600}
.timeline{max-height:200px;overflow-y:auto;margin-bottom:16px}
.timeline::-webkit-scrollbar{width:4px}
.timeline::-webkit-scrollbar-thumb{background:#30363d;border-radius:2px}
.tl-entry{display:flex;gap:8px;padding:4px 0;border-bottom:1px solid #21262d;font-size:12px}
.tl-time{color:#8b949e;flex:0 0 55px;font-family:'SF Mono',Monaco,monospace;font-size:11px}
.tl-tool{color:#58a6ff;flex:0 0 auto}
.tl-arrow{color:#484f58}
.tl-detail{color:#c9d1d9;flex:1}
.tl-status-success .tl-detail{color:#3fb950}
.tl-status-error .tl-detail{color:#da3633}
.tl-status-warning .tl-detail{color:#d29922}
.brain{display:flex;align-items:center;gap:8px;padding:8px 12px;background:#161b22;border:1px solid #30363d;border-radius:6px;font-size:12px}
.brain-icon{font-size:16px}
.brain-text{color:#c9d1d9}
.brain-trend{color:#3fb950;font-weight:600}
.brain-trend.down{color:#da3633}
.empty{text-align:center;padding:32px 16px;color:#484f58;font-size:12px}
</style>
</head>
<body>
<div class="header">
  <h1>Rigour Governance</h1>
  <span class="badge badge-idle" id="statusBadge">idle</span>
</div>

<div class="top">
  <div class="gauge-wrap">
    <svg viewBox="0 0 100 100" width="90" height="90">
      <circle cx="50" cy="50" r="42" fill="none" stroke="#21262d" stroke-width="8"/>
      <circle cx="50" cy="50" r="42" fill="none" stroke="#30363d" stroke-width="8"
        stroke-dasharray="264" stroke-dashoffset="264" stroke-linecap="round"
        transform="rotate(-90 50 50)" id="gaugeArc"/>
      <text x="50" y="46" text-anchor="middle" fill="#f0f6fc" font-size="22" font-weight="700" id="gaugeText">--</text>
      <text x="50" y="62" text-anchor="middle" fill="#8b949e" font-size="9">SCORE</text>
    </svg>
  </div>
  <div class="severity-wrap" id="severityWrap">
    <div class="sev-row"><span class="sev-dot sev-critical"></span><span class="sev-count" id="sevCritical">0</span>critical</div>
    <div class="sev-row"><span class="sev-dot sev-high"></span><span class="sev-count" id="sevHigh">0</span>high</div>
    <div class="sev-row"><span class="sev-dot sev-medium"></span><span class="sev-count" id="sevMedium">0</span>medium</div>
    <div class="sev-row"><span class="sev-dot sev-low"></span><span class="sev-count" id="sevLow">0</span>low</div>
  </div>
</div>

<div class="section-title">Activity</div>
<div class="timeline" id="timeline">
  <div class="empty">Waiting for agent activity...</div>
</div>

<div class="brain" id="brainSection">
  <span class="brain-icon">&#x1F9E0;</span>
  <span class="brain-text" id="brainText">Brain: waiting for data</span>
  <span class="brain-trend" id="brainTrend"></span>
</div>

<script>
const state = JSON.parse('__INITIAL_STATE__');

function scoreColor(s) {
  if (s === null) return '#30363d';
  if (s < 50) return '#da3633';
  if (s < 80) return '#d29922';
  return '#3fb950';
}

function updateGauge(score) {
  const arc = document.getElementById('gaugeArc');
  const text = document.getElementById('gaugeText');
  if (score === null) {
    arc.setAttribute('stroke-dashoffset', '264');
    arc.setAttribute('stroke', '#30363d');
    text.textContent = '--';
    return;
  }
  const offset = 264 - (264 * Math.min(score, 100) / 100);
  arc.setAttribute('stroke-dashoffset', String(offset));
  arc.setAttribute('stroke', scoreColor(score));
  text.textContent = String(Math.round(score));
}

function updateBadge(status) {
  const badge = document.getElementById('statusBadge');
  badge.className = 'badge badge-' + (status || 'idle');
  const labels = {pass:'PASS',fail:'FAIL',scanning:'SCANNING'};
  badge.textContent = labels[status] || 'IDLE';
}

function updateSeverity(sev) {
  document.getElementById('sevCritical').textContent = sev.critical || 0;
  document.getElementById('sevHigh').textContent = sev.high || 0;
  document.getElementById('sevMedium').textContent = sev.medium || 0;
  document.getElementById('sevLow').textContent = sev.low || 0;
}

function formatTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString('en-US', {hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'});
}

function renderTimeline(entries) {
  const el = document.getElementById('timeline');
  if (!entries.length) {
    el.innerHTML = '<div class="empty">Waiting for agent activity...</div>';
    return;
  }
  el.innerHTML = entries.map(e => {
    const cls = e.status === 'success' ? 'tl-status-success' : e.status === 'error' ? 'tl-status-error' : 'tl-status-warning';
    return '<div class="tl-entry ' + cls + '">' +
      '<span class="tl-time">' + formatTime(e.timestamp) + '</span>' +
      '<span class="tl-tool">' + e.tool + '</span>' +
      '<span class="tl-arrow">\u2192</span>' +
      '<span class="tl-detail">' + e.details + '</span></div>';
  }).join('');
  el.scrollTop = el.scrollHeight;
}

function updateBrain(patterns, trend) {
  const text = document.getElementById('brainText');
  const trendEl = document.getElementById('brainTrend');
  text.textContent = 'Brain: ' + patterns + ' patterns learned';
  if (trend) {
    const arrows = {improving:'\u2191',stable:'\u2194',declining:'\u2193'};
    trendEl.textContent = (arrows[trend] || '') + ' ' + trend;
    trendEl.className = 'brain-trend' + (trend === 'declining' ? ' down' : '');
  }
}

function render() {
  updateGauge(state.currentScore);
  updateBadge(state.status);
  updateSeverity(state.severityBreakdown || {});
  renderTimeline(state.timeline || []);
  updateBrain(state.brainPatterns || 0, state.brainTrend);
}

render();
</script>
</body>
</html>`;
