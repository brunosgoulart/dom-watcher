'use strict';

const API_URL = window.RUNTIME_MONITOR_API || '/api/v1/status';
const POLL_MS = 3000;
const FOCUS_MS = 4000;
const ORBIT_METRICS = [
  ['runCPU', 'CPU E3Run', '%', 1], ['runMemory', 'Memória', '%', 1],
  ['runTRD', 'Threads', '', 0], ['runOccupancy', 'Ocupação', '%', 1],
  ['runErrorsPerMinute', 'Erros de scripts', '/min', 1],
  ['runLocalPending', 'Fila local', 'eventos', 0], ['runRemotePending', 'Fila remota', 'eventos', 0],
  ['ioQueueAvgDelay', 'Atraso de E/S', '', 2]
];
const HEALTH = { critical: ['Crítico', 0], warning: ['Atenção', 1], unknown: ['Não confirmado', 2], healthy: ['Conforme', 3] };
let snapshot = null;
let focusIndex = 0;
let focusKey = null;
let motionPaused = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

const $ = id => document.getElementById(id);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const format = (value, digits = 0) => Number.isFinite(value) ? new Intl.NumberFormat('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value) : '—';
const nowText = () => new Intl.DateTimeFormat('pt-BR', { dateStyle: 'full', timeStyle: 'medium', timeZone: 'America/Sao_Paulo' }).format(new Date());

function metricValue(server, key) {
  const quality = server.metricQuality?.[key];
  const value = server.metrics?.[key];
  return quality?.good === true && (typeof value === 'number' && Number.isFinite(value) || typeof value === 'string' && value) ? value : null;
}
function signalState(signal) { return signal?.state === 20 ? 'critical' : signal?.state === 10 ? 'warning' : 'healthy'; }
function serverState(server) {
  const signals = [...(server.trends || []), ...(server.absoluteAlarms || [])];
  if (signals.some(signal => signalState(signal) === 'critical')) return 'critical';
  if (signals.some(signal => signalState(signal) === 'warning')) return 'warning';
  const vital = ['runCPU', 'runMemory', 'runErrorsPerMinute'];
  if (!server.collecting || vital.some(key => metricValue(server, key) === null)) return 'unknown';
  return 'healthy';
}
function stateForMetric(server, key) {
  if (metricValue(server, key) === null) return 'unknown';
  const signal = [...(server.absoluteAlarms || []), ...(server.trends || [])].find(item => item.metric === key && [10, 20].includes(item.state));
  return signal ? signalState(signal) : 'healthy';
}
function orbitItems() {
  return (snapshot?.servers || []).flatMap(server => ORBIT_METRICS.map(([key, label, unit, digits]) => ({ server, key, label, unit, digits, value: metricValue(server, key), state: stateForMetric(server, key) })))
    .sort((a, b) => HEALTH[a.state][1] - HEALTH[b.state][1] || a.server.name.localeCompare(b.server.name));
}
function activeSignals() {
  return (snapshot?.servers || []).flatMap(server => [...(server.absoluteAlarms || []), ...(server.trends || [])]
    .filter(item => [10, 20].includes(item.state)).map(item => ({ ...item, server, state: signalState(item) })))
    .sort((a, b) => HEALTH[a.state][1] - HEALTH[b.state][1]);
}
function renderTrend(item) {
  const chart = $('trend-chart');
  if (!item) {
    $('trend-title').textContent = 'Métrica em foco';
    $('trend-context').textContent = 'Aguardando série temporal';
    chart.innerHTML = '<text class="trend-empty" x="380" y="120" text-anchor="middle">Sem dados históricos</text>';
    return;
  }
  const points = (item.server.chartHistory?.[item.key] || []).filter(point => Number.isFinite(point?.timestamp) && Number.isFinite(point?.value)).sort((a, b) => a.timestamp - b.timestamp);
  $('trend-title').textContent = `${item.label} - ${item.server.name}`;
  $('trend-context').textContent = 'Últimas 4 horas';
  if (points.length < 2) {
    chart.innerHTML = '<text class="trend-empty" x="380" y="120" text-anchor="middle">Histórico insuficiente para análise</text>';
    return;
  }
  const height = 240; const width = Math.max(760, Math.round(chart.clientWidth / Math.max(chart.clientHeight, 1) * height)); const left = 20; const right = 2; const top = 10; const bottom = 28;
  chart.setAttribute('viewBox', `0 0 ${width} ${height}`);
  const minimum = Math.min(...points.map(point => point.value)); const maximum = Math.max(...points.map(point => point.value));
  const range = maximum - minimum;
  const minimumRange = Math.max(Math.abs(maximum) * .1, item.digits > 0 ? 0.2 : 1);
  const padding = Math.max(range * .14, minimumRange * .1);
  const center = (minimum + maximum) / 2;
  const lower = 0;
  const upper = range < minimumRange ? Math.max(minimumRange, center + minimumRange / 2) : maximum + padding;
  const axisStep = (upper - lower) / 3;
  const axisDigits = axisStep < 1
    ? Math.max(item.digits, Math.min(3, Math.ceil(-Math.log10(axisStep))))
    : item.digits;
  const start = points[0].timestamp; const end = points.at(-1).timestamp; const timeSpan = Math.max(end - start, 1); const valueSpan = Math.max(upper - lower, 1);
  const position = point => ({ x: left + (point.timestamp - start) / timeSpan * (width - left - right), y: top + (upper - point.value) / valueSpan * (height - top - bottom) });
  const positions = points.map(position); const line = positions.map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
  const area = `${line} L${positions.at(-1).x.toFixed(1)},${height - bottom} L${positions[0].x.toFixed(1)},${height - bottom} Z`;
  const latest = positions.at(-1); const color = item.state === 'critical' ? 'critical' : item.state === 'warning' ? 'warning' : 'good';
  const timestamp = value => new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' }).format(new Date(value));
  const yTicks = Array.from({ length: 4 }, (_, index) => upper - index * (upper - lower) / 3);
  const xTicks = Array.from({ length: 5 }, (_, index) => start + index * (end - start) / 4);
  const yMarkup = yTicks.map(value => {
    const y = top + (upper - value) / valueSpan * (height - top - bottom);
    return `<line x1="${left}" x2="${width - right}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"/><text class="trend-axis trend-y-axis" x="${left + 4}" y="${(y + 3.5).toFixed(1)}">${format(value, axisDigits)}</text>`;
  }).join('');
  const xMarkup = xTicks.map((value, index) => {
    const x = left + index / 4 * (width - left - right); const anchor = index === 0 ? 'start' : index === 4 ? 'end' : 'middle';
    return `<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${top}" y2="${height - bottom}"/><text class="trend-axis" x="${x.toFixed(1)}" y="${height - 10}" text-anchor="${anchor}">${timestamp(value)}</text>`;
  }).join('');
  chart.innerHTML = `<g class="trend-grid">${yMarkup}${xMarkup}</g><path class="trend-area ${color}" d="${area}"/><path class="trend-line ${color}" d="${line}"/><circle class="trend-point ${color}" cx="${latest.x.toFixed(1)}" cy="${latest.y.toFixed(1)}" r="5"/>`;
}
function renderFocus(items) {
  if (!items.length) { renderTrend(null); return; }
  const keyedIndex = focusKey ? items.findIndex(item => `${item.server.id}:${item.key}` === focusKey) : -1;
  if (keyedIndex >= 0) focusIndex = keyedIndex;
  focusIndex = ((focusIndex % items.length) + items.length) % items.length;
  const item = items[focusIndex];
  focusKey = `${item.server.id}:${item.key}`;
  const state = item.state;
  const timestamp = item.server.metricQuality?.[item.key]?.timestamp ?? item.server.sampleTime;
  const collectedAt = Number.isFinite(timestamp)
    ? new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'medium', timeZone: 'America/Sao_Paulo' }).format(new Date(timestamp))
    : 'Coleta não confirmada';
  $('focus-card').className = `focus-card ${state}`;
  $('focus-card').innerHTML = `<span class="focus-label">${escapeHtml(item.server.name)} - ${escapeHtml(HEALTH[state][0].toLocaleUpperCase('pt-BR'))}</span><h2>${escapeHtml(item.label)}</h2><strong>${format(item.value, item.digits)}<small>${item.value === null ? 'Sem dados' : escapeHtml(item.unit)}</small></strong><p>Última coleta: ${escapeHtml(collectedAt)}</p>`;
  renderTrend(item);
}
function renderOrbit() {
  const items = orbitItems();
  const total = items.length;
  const radiusX = Math.max(250, Math.min(650, window.innerWidth * .36));
  const radiusY = Math.max(105, Math.min(230, window.innerHeight * .18));
  const bubbleMarkup = (item, index) => {
    const relative = (index - focusIndex + total) % total;
    const angle = relative / total * Math.PI * 2 - Math.PI / 2;
    const depth = Math.round(Math.sin(angle) * 135);
    const x = Math.round(Math.cos(angle) * radiusX);
    const y = Math.round(Math.sin(angle) * radiusY);
    const scale = (.56 + (depth + 135) / 270 * .38 + (item.state !== 'healthy' ? .08 : 0)).toFixed(2);
    const value = item.value === null ? '—' : format(item.value, item.digits);
    return `<button type="button" class="orbit-bubble ${item.state}" data-orbit-key="${escapeHtml(`${item.server.id}:${item.key}`)}" data-orbit-index="${index}" style="--x:${x}px;--y:${y}px;--z:${depth}px;--scale:${scale};--order:${depth + 150}" aria-label="${escapeHtml(item.server.name)}: ${escapeHtml(item.label)}, ${escapeHtml(value)} ${escapeHtml(item.unit)}"><span>${escapeHtml(item.server.name)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(item.label)}${item.unit ? ` · ${escapeHtml(item.unit)}` : ''}</small></button>`;
  };
  const host = $('orbit-bubbles');
  const currentKeys = [...host.querySelectorAll('[data-orbit-key]')].map(item => item.dataset.orbitKey);
  const nextKeys = items.map(item => `${item.server.id}:${item.key}`);
  if (items.length && currentKeys.length === nextKeys.length && currentKeys.every(key => nextKeys.includes(key))) {
    items.forEach((item, index) => {
      const key = `${item.server.id}:${item.key}`;
      const previous = host.querySelector(`[data-orbit-key="${CSS.escape(key)}"]`);
      const relative = (index - focusIndex + total) % total;
      const angle = relative / total * Math.PI * 2 - Math.PI / 2;
      const depth = Math.round(Math.sin(angle) * 135);
      const x = Math.round(Math.cos(angle) * radiusX);
      const y = Math.round(Math.sin(angle) * radiusY);
      const scale = (.56 + (depth + 135) / 270 * .38 + (item.state !== 'healthy' ? .08 : 0)).toFixed(2);
      const value = item.value === null ? '—' : format(item.value, item.digits);
      previous.className = `orbit-bubble ${item.state}`;
      previous.dataset.orbitIndex = index;
      previous.style.setProperty('--x', `${x}px`);
      previous.style.setProperty('--y', `${y}px`);
      previous.style.setProperty('--z', `${depth}px`);
      previous.style.setProperty('--scale', scale);
      previous.style.setProperty('--order', depth + 150);
      previous.setAttribute('aria-label', `${item.server.name}: ${item.label}, ${value} ${item.unit}`);
      previous.innerHTML = `<span>${escapeHtml(item.server.name)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(item.label)}${item.unit ? ` · ${escapeHtml(item.unit)}` : ''}</small>`;
    });
  } else host.innerHTML = items.map(bubbleMarkup).join('') || '<p class="empty-copy">Nenhuma métrica disponível.</p>';
  renderFocus(items);
}
function renderAlerts() {
  const signals = activeSignals();
  $('alert-count').textContent = signals.length;
  $('alert-list').innerHTML = signals.length ? signals.slice(0, 5).map(signal => {
    const metric = ORBIT_METRICS.find(item => item[0] === signal.metric);
    const [,, unit = '', digits = 0] = metric || [];
    const value = metricValue(signal.server, signal.metric);
    const label = metric?.[1] || signal.label || signal.metric || 'Sinalização';
    const reason = signal.reason || signal.description || (signal.kind === 'absolute' ? 'Limite ultrapassado' : 'Elevação identificada');
    return `<article class="alarm ${signal.state}"><i aria-hidden="true">${signal.state === 'critical' ? '!' : '▲'}</i><div><strong>${escapeHtml(signal.server.name)} · ${escapeHtml(label)}</strong><span>${escapeHtml(reason)}</span></div><b>${format(value, digits)}<small>${value === null ? 'Sem dados' : escapeHtml(unit)}</small></b></article>`;
  }).join('') : '<p class="empty-copy">Nenhum desvio confirmado neste instante.</p>';
}
function renderServers() {
  const servers = snapshot?.servers || [];
  $('server-list').innerHTML = servers.map(server => {
    const state = serverState(server);
    const signals = activeSignals().filter(signal => signal.server.id === server.id).length;
    const cpu = metricValue(server, 'runCPU');
    const memory = metricValue(server, 'runMemory');
    return `<article class="server-tile ${state}"><span class="server-light" aria-hidden="true"></span><div><strong>${escapeHtml(server.name)}</strong><small>${escapeHtml(HEALTH[state][0])}${signals ? ` · ${signals} alerta${signals > 1 ? 's' : ''}` : ''}</small></div><dl><div><dt>CPU</dt><dd>${format(cpu, 1)}<em>${cpu === null ? '' : '%'}</em></dd></div><div><dt>RAM</dt><dd>${format(memory, 1)}<em>${memory === null ? '' : '%'}</em></dd></div></dl></article>`;
  }).join('') || '<p class="empty-copy">Nenhum servidor recebido.</p>';
}
function renderHeader() {
  $('api-state').textContent = snapshot?.source === 'simulated' ? 'SIMULAÇÃO LOCAL' : 'LEITURA OPERACIONAL';
  $('updated-state').textContent = snapshot?.generatedAt ? `Atualizado ${new Date(snapshot.generatedAt).toLocaleTimeString('pt-BR')}` : 'Sem atualização';
}
function render() { renderHeader(); renderOrbit(); }
async function refresh() {
  try {
    const response = await fetch(API_URL, { cache: 'no-store', headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    snapshot = await response.json();
    render();
  } catch (error) {
    $('api-state').textContent = `API indisponível · ${error.message}`;
  }
}
function advanceFocus() { if (!motionPaused && orbitItems().length) { focusIndex++; focusKey = null; renderOrbit(); } }
$('orbit-bubbles').addEventListener('click', event => { const bubble = event.target.closest('[data-orbit-key]'); if (!bubble) return; focusKey = bubble.dataset.orbitKey; renderOrbit(); });
$('motion-toggle').addEventListener('click', event => { motionPaused = !motionPaused; event.currentTarget.textContent = motionPaused ? 'Retomar órbita' : 'Pausar órbita'; event.currentTarget.setAttribute('aria-pressed', String(motionPaused)); $('orbit-workspace').dataset.motion = motionPaused ? 'paused' : 'active'; });
setInterval(refresh, POLL_MS); setInterval(advanceFocus, FOCUS_MS); setInterval(() => { $('clock').textContent = nowText(); }, 1000);
window.addEventListener('resize', () => { if (snapshot) renderOrbit(); });
$('clock').textContent = nowText(); refresh();
