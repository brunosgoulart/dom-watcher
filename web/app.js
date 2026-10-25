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
function renderFocus(items) {
  if (!items.length) return;
  focusIndex = ((focusIndex % items.length) + items.length) % items.length;
  const item = items[focusIndex];
  const state = item.state;
  const timestamp = item.server.metricQuality?.[item.key]?.timestamp ?? item.server.sampleTime;
  const collectedAt = Number.isFinite(timestamp)
    ? new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'medium', timeZone: 'America/Sao_Paulo' }).format(new Date(timestamp))
    : 'Coleta não confirmada';
  $('focus-card').className = `focus-card ${state}`;
  $('focus-card').innerHTML = `<span class="focus-label">${escapeHtml(item.server.name)} - ${escapeHtml(HEALTH[state][0].toLocaleUpperCase('pt-BR'))}</span><h2>${escapeHtml(item.label)}</h2><strong>${format(item.value, item.digits)}<small>${item.value === null ? 'Sem dados' : escapeHtml(item.unit)}</small></strong><p>Última coleta: ${escapeHtml(collectedAt)}</p>`;
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
  $('orbit-context').textContent = `${total} pontos em órbita · prioridade visual para desvios`;
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
  const servers = snapshot?.servers || [];
  const states = servers.map(serverState);
  const state = states.includes('critical') ? 'critical' : states.includes('warning') ? 'warning' : states.includes('unknown') ? 'unknown' : 'healthy';
  const label = state === 'critical' ? 'Atenção imediata necessária' : state === 'warning' ? 'Desvio sob acompanhamento' : state === 'unknown' ? 'Estado não confirmado' : 'Operação dentro dos limites';
  $('headline').className = `headline ${state}`;
  $('headline').innerHTML = `<span class="headline-dot"></span><strong>${label}</strong><small>${servers.length} servidor${servers.length === 1 ? '' : 'es'} no monitoramento</small>`;
  const source = snapshot?.source === 'simulated' ? 'Dados simulados — sem leitura PI' : snapshot?.source === 'af-sdk' ? 'PI Data Archive · AF SDK' : snapshot?.source === 'pi-sdk-com' ? 'PI Data Archive · PI SDK COM' : 'Fonte não confirmada';
  $('source-state').textContent = source;
  $('api-state').textContent = snapshot?.source === 'simulated' ? 'SIMULAÇÃO LOCAL' : 'LEITURA OPERACIONAL';
  $('updated-state').textContent = snapshot?.generatedAt ? `Atualizado ${new Date(snapshot.generatedAt).toLocaleTimeString('pt-BR')}` : 'Sem atualização';
}
function render() { renderHeader(); renderOrbit(); renderAlerts(); renderServers(); }
async function refresh() {
  try {
    const response = await fetch(API_URL, { cache: 'no-store', headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    snapshot = await response.json();
    render();
  } catch (error) {
    $('api-state').textContent = `API indisponível · ${error.message}`;
    $('headline').className = 'headline unknown';
    $('headline').innerHTML = '<span class="headline-dot"></span><strong>Estado não confirmado</strong><small>Não foi possível obter telemetria</small>';
  }
}
function advanceFocus() { if (!motionPaused && orbitItems().length) { focusIndex++; renderOrbit(); } }
$('orbit-bubbles').addEventListener('click', event => { const bubble = event.target.closest('[data-orbit-index]'); if (!bubble) return; focusIndex = Number(bubble.dataset.orbitIndex); renderOrbit(); });
$('motion-toggle').addEventListener('click', event => { motionPaused = !motionPaused; event.currentTarget.textContent = motionPaused ? 'Retomar órbita' : 'Pausar órbita'; event.currentTarget.setAttribute('aria-pressed', String(motionPaused)); $('orbit-workspace').dataset.motion = motionPaused ? 'paused' : 'active'; });
setInterval(refresh, POLL_MS); setInterval(advanceFocus, FOCUS_MS); setInterval(() => { $('clock').textContent = nowText(); }, 1000);
window.addEventListener('resize', () => { if (snapshot) renderOrbit(); });
$('clock').textContent = nowText(); refresh();
