/* SCADA monitoring interface. */
'use strict';
const format = (value, digits = 0) => Number.isFinite(value) ? new Intl.NumberFormat('pt-BR', { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(value) : '—';
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const main = document.getElementById('main');
let paused = false;
// Separate from the global update pause: freezes only automatic navigation
// between server pages while PI polling remains active.
let carouselPaused = false;
let activeServerId = null;
let carouselIndex = 0;
let monitoringPage = 0;
let overviewMetricPage = 0;
let detailMetricPage = 0;
let detailAlarmPage = 0;
const CAROUSEL_INTERVAL_MS = 10000;
const ORBIT_INTERVAL_MS = 4000;
let orbitFocusMetricKey = null;
let topologySelectedId = null;
let topologyFilters = { zone: 'all', protocol: 'all', risk: 'all' };
let topologyLastSignature = '';
const ALARM_LABELS = { runCPU: 'CPU', runMemory: 'RAM', runPVT: 'Memória privada', runTRD: 'Threads', runErrorsPerMinute: 'Erros', runLocalPending: 'Fila local', runRemotePending: 'Fila remota' };
function contextIcon(kind) {
  const paths = {
    trend: '<path d="m4 16 5-5 4 3 7-10M14 4h6v6"/>',
    absolute: '<path d="M4 6h16M12 20V10m-4 4 4-4 4 4"/>',
    readings: '<path d="M3 12h4l3-7 4 14 3-7h4"/>',
    history: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3 2"/>',
    paused: '<path d="M9 5v14M15 5v14"/>',
    unknown: '<circle cx="12" cy="12" r="8.5"/><path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4m0 3h.01"/>'
  };
  return `<svg class="context-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths[kind] || paths.unknown}</svg>`;
}
const dashboardDateFormatter = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const dashboardTimeFormatter = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
function dashboardDateTime(now = new Date()) {
  return `${dashboardDateFormatter.format(now)} - ${dashboardTimeFormatter.format(now)}`;
}
function renderClock() {
  const now = new Date();
  const clock = document.getElementById('current-datetime');
  clock.textContent = dashboardDateTime(now);
  clock.dateTime = now.toISOString();
}
const statusBadge = state => `<span class="health-badge ${state}"><i aria-hidden="true"></i>${HEALTH_STATES[state].label}</span>`;
function sampleAge(server) {
  if (!Number.isFinite(server.sampleTime)) return '—';
  const seconds = Math.max(0, Math.floor((Date.now() - server.sampleTime) / 1000));
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min`;
}
function currentMetric(server, key, now = Date.now()) {
  if (server.apiAvailable === false) return null;
  const quality = server.metricQuality?.[key];
  const timestamp = quality ? quality.timestamp : server.sampleTime;
  const value = server.metrics?.[key];
  return hasMetricValue(key, value) && (!quality || quality.good === true) && Number.isFinite(timestamp) && timestamp <= now && now - timestamp <= HEALTH_LIMITS.staleSeconds * 1000 ? value : null;
}
function visibleMetrics(server) { return Object.fromEntries(Object.keys(server.metrics || {}).map(key => [key, currentMetric(server, key)])); }
function readingCoverage(servers) {
  const readings = servers.flatMap(server => serverMetricGroups(visibleMetrics(server)).flatMap(group => group.items));
  return { available: readings.filter(item => hasMetricValue(item.key, item.value)).length, total: readings.length };
}
function readingContext(servers) {
  const {available, total} = readingCoverage(servers);
  const state = paused ? 'paused' : !available ? 'unknown' : available < total ? 'partial' : 'complete';
  const label = paused ? 'Atualização pausada' : !available ? 'Sem leituras recentes' : available < total ? 'Leitura parcial' : 'Leituras recentes';
  return `<div class="reading-context" data-reading-state="${state}" aria-label="Disponibilidade das medições">${contextIcon(paused ? 'paused' : !available ? 'unknown' : 'readings')}<div><strong>${label}</strong><span>${available} / ${total} pontos${servers.length > 1 ? ` · ${servers.length} servidores` : ''}</span></div></div>`;
}
function serverAlarmPanel(server, health, pageSize = health.signals.length || 1, page = 0) {
  const points = { runCPU: ['E3Run.CPU', '%', 1], runMemory: ['Sistema.Memória', '%', 1], runPVT: ['E3Run.MemóriaPrivada', 'KiB', 0], runTRD: ['E3Run.Threads', 'threads', 0], runErrorsPerMinute: ['E3Run.ErrosScripts', 'erros/min', 1], runLocalPending: ['E3Run.FilaLocal', 'eventos', 0], runRemotePending: ['E3Run.FilaRemota', 'eventos', 0] };
  const activeCount = health.signals.filter(signal => ['critical', 'warning'].includes(signal.state)).length;
  const heading = activeCount ? `${activeCount} ${activeCount === 1 ? 'alarme ativo' : 'alarmes ativos'} neste servidor` : health.signals.length ? 'Diagnóstico dos alarmes' : 'Nenhum alarme ativo';
  const pages = Math.max(1, Math.ceil(health.signals.length / pageSize));
  const visibleSignals = health.signals.slice((page % pages) * pageSize, (page % pages) * pageSize + pageSize);
  const rows = visibleSignals.map(signal => {
    const active = ['critical', 'warning'].includes(signal.state);
    const [point, unit, digits] = points[signal.metric] || [signal.title, '', 0];
    const value = active && signal.metric ? currentMetric(server, signal.metric) : null;
    const condition = !signal.metric ? (active ? 'Falha de publicação' : 'Dados indisponíveis') : !active ? 'Dados ou histórico indisponíveis' : signal.kind === 'absolute' ? (unit === '%' ? 'Percentual Muito Alto' : 'Valor Muito Alto') : 'Tendência de Elevação';
    const reading = signal.metric && active ? ` (${format(value, digits)}${Number.isFinite(value) ? ` ${unit}` : ''})` : '';
    const text = `${point} - ${condition}${reading}`;
    return `<li class="detail-alarm ${signal.state}" title="${escapeHtml(signal.description || '')}">${monitoringSeverityIcon(signal.state)}<span class="detail-alarm-text">${escapeHtml(text)}</span><span class="detail-alarm-state">- ${active ? 'Ativo' : 'Indisponível'}</span></li>`;
  }).join('');
  const pager = pages > 1 ? `<div class="detail-alarm-pages"><button type="button" data-detail-alarm-page="${(page - 1 + pages) % pages}" aria-label="Alarmes anteriores">←</button><span>${page % pages + 1} / ${pages}</span><button type="button" data-detail-alarm-page="${(page + 1) % pages}" aria-label="Próximos alarmes">→</button></div>` : '';
  return `<section class="server-alerts ${health.state}" aria-label="Alarmes do servidor"><div class="detail-alarm-heading"><strong>${heading}</strong>${pager}</div>${rows ? `<ul class="detail-alarm-list">${rows}</ul>` : '<p>Nenhum limite ou tendência de elevação ativo.</p>'}</section>`;
}
function monitoringSeverityIcon(state) {
  const shape = state === 'critical'
    ? '<path d="M8 2h8l6 6v8l-6 6H8l-6-6V8Z"/><path class="monitoring-icon-mark" d="M12 6.5v6m0 4h.01"/>'
    : state === 'warning'
      ? '<path d="M10.3 3.8a2 2 0 0 1 3.4 0l8 14a2 2 0 0 1-1.7 3H4a2 2 0 0 1-1.7-3Z"/><path class="monitoring-icon-mark" d="M12 9v4m0 4h.01"/>'
      : '<circle cx="12" cy="12" r="10"/><path class="monitoring-icon-mark" d="M9 8.5a3 3 0 0 1 6 .5c0 2-3 2.5-3 4.5m0 3.5h.01"/>';
  return `<span class="monitoring-severity-icon" data-severity="${state}" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false">${shape}</svg></span>`;
}
function monitoringPanel() {
  const allSignals = SERVERS.flatMap(server => healthOf(server).signals.map(signal => ({ ...signal, server })));
  const unknownServers = new Set(allSignals.filter(signal => signal.state === 'unknown').map(signal => signal.server.id)).size;
  const signals = allSignals.filter(signal => ['critical', 'warning'].includes(signal.state))
    .sort((a, b) => HEALTH_STATES[a.state].priority - HEALTH_STATES[b.state].priority || a.server.name.localeCompare(b.server.name));
  const historyEvents = PI_DATA_STATE.alarmHistory || [];
  const pages = Math.max(1, Math.ceil(signals.length / 2));
  const activePage = monitoringPage % pages;
  const units = { runCPU: ['%', 1], runMemory: ['%', 1], runPVT: ['KiB', 0], runTRD: ['threads', 0], runErrorsPerMinute: ['/min', 1], runLocalPending: ['eventos', 0], runRemotePending: ['eventos', 0] };
  const affectedServers = new Set(signals.map(signal => signal.server.id)).size;
  const cards = signals.slice(activePage * 2, activePage * 2 + 2).map(signal => {
    const [unit, digits] = units[signal.metric] || ['', 0];
    const value = signal.state === 'unknown' ? null : currentMetric(signal.server, signal.metric);
    const rate = signal.state === 'unknown' ? '' : signal.description.split(' · ')[0];
    const explanation = rate.replace(/^↑ (.+?) por minuto$/, 'Aumento de $1 ponto percentual por minuto');
    const timestamp = signal.server.metricQuality?.[signal.metric]?.timestamp || signal.server.sampleTime;
    const observedAt = Number.isFinite(timestamp) ? new Date(timestamp).toLocaleTimeString('pt-BR') : 'Horário indisponível';
    const kind = signal.kind === 'absolute' ? 'absolute' : signal.metric ? 'trend' : 'unknown';
    return `<a class="compact-alarm ${signal.state}" href="#server/${encodeURIComponent(signal.server.id)}" title="${escapeHtml(signal.description)}">${monitoringSeverityIcon(signal.state)}<div class="compact-alarm-top"><span>${escapeHtml(ALARM_LABELS[signal.metric] || signal.title)}${signal.kind === 'absolute' ? ' · Limite' : ''}</span><span class="compact-alarm-state">${escapeHtml(signal.stateLabel || HEALTH_STATES[signal.state].label)}</span></div><span class="compact-alarm-server">${escapeHtml(signal.server.name)} <span>${observedAt} ↗</span></span><strong>${format(value, digits)}${Number.isFinite(value) ? ` <small>${unit}</small>` : ''}</strong><span class="compact-alarm-rate" data-alarm-kind="${kind}" title="${escapeHtml(explanation)}">${contextIcon(kind)}<span>${escapeHtml(rate)}</span></span></a>`;
  }).join('');
  const uncertain = unknownServers > 0 || !SERVERS.length;
  const empty = `<div class="alarm-status-summary ${uncertain ? 'unknown' : 'healthy'}"><span class="empty-status-icon" aria-hidden="true">${uncertain ? '?' : '✓'}</span><div><strong>${uncertain ? 'Estado não confirmado' : 'Nenhum alarme ativo'}</strong><p>${uncertain ? 'Há dados ou análises indisponíveis. Consulte o servidor.' : 'Nenhum limite ou tendência de elevação ativo.'}</p></div></div>`;
  const context = signals.length ? `${signals.length} ${signals.length === 1 ? 'alarme ativo' : 'alarmes ativos'} em ${affectedServers} ${affectedServers === 1 ? 'servidor' : 'servidores'}` : uncertain ? 'Aguardando dados ou análises válidas' : 'Nenhum limite ou elevação sinalizado';
  return `<div class="compact-monitor-heading"><div><h2>Monitoramento</h2><p class="monitoring-context">${context}</p></div><div class="alarm-counts"><span class="critical" data-count="${signals.filter(s => s.state === 'critical').length}">${signals.filter(s => s.state === 'critical').length} críticos</span><span class="warning" data-count="${signals.filter(s => s.state === 'warning').length}">${signals.filter(s => s.state === 'warning').length} atenção</span>${unknownServers ? `<span class="unknown">${unknownServers} com diagnóstico pendente</span>` : ''}</div></div><div class="monitoring-content"><section class="active-alarms"><div class="section-heading"><h3>Ativos agora</h3><span class="compact-monitor-caption">${signals.length ? `Página ${activePage + 1} de ${pages}` : 'Estado atual'}</span></div><div class="compact-alarm-list">${cards || empty}</div></section>${alarmHistoryPanel(historyEvents, monitoringPage)}</div>`;
}
function renderMetricPageControls(pages, page, detail = false) {
  document.getElementById('metric-page-controls').innerHTML = pages.map((label, index) => `<button type="button" id="metric-page-${index}" ${detail ? `data-detail-metric-page="${index}"` : `data-metric-page="${index}"`} aria-pressed="${page === index}">${label}</button>`).join('');
}
function alarmHistoryPanel(events = PI_DATA_STATE.alarmHistory || [], page = 0) {
  const pages = Math.max(1, Math.ceil(events.length / 2));
  const offset = (page % pages) * 2;
  const rows = events.slice(offset, offset + 2).map(event => `<a class="alarm-history-item ${event.state}" href="#server/${encodeURIComponent(event.serverId)}" title="${escapeHtml(event.description)}"><span class="history-dot" aria-hidden="true"></span><div><div class="history-meta"><strong>${escapeHtml(event.serverName)}</strong><time>${new Date(event.observedAt).toLocaleTimeString('pt-BR')}</time></div><span>${HEALTH_STATES[event.state]?.label || 'Evento'} · ${escapeHtml(Object.hasOwn(ALARM_LABELS, event.title) ? ALARM_LABELS[event.title] : event.title)}</span><small>${new Date(event.observedAt).toLocaleDateString('pt-BR')} · ${escapeHtml(event.description)}</small></div></a>`).join('');
  return `<section class="alarm-history" aria-label="Histórico de alarmes"><div class="section-heading"><h3>${contextIcon('history')}Histórico recente</h3><span>${events.length ? `${page % pages + 1} / ${pages}` : 'Eventos'}</span></div><div class="alarm-history-list">${rows || '<p class="history-empty">Nenhum evento registrado.<br><span>Os próximos alarmes aparecerão aqui.</span></p>'}</div></section>`;
}
function fleetNavigation() {
  return `<div class="fleet-strip"><div class="fleet-navigation" aria-label="Selecionar medições do servidor">${SERVERS.map((server, index) => {
    const health = healthOf(server);
    return `<button type="button" id="server-switch-${escapeHtml(server.id)}" class="server-switch ${health.state}" data-carousel-index="${index}" aria-pressed="${carouselIndex === index}"><i aria-hidden="true"></i><span><strong>${escapeHtml(server.name)}</strong><small>${HEALTH_STATES[health.state].label}</small></span></button>`;
  }).join('')}</div>${readingContext(SERVERS)}</div>`;
}
function metricState(metric, health) {
  const signal = health.signals.filter(item => item.metric === metric.key)
    .sort((a, b) => HEALTH_STATES[a.state].priority - HEALTH_STATES[b.state].priority)[0];
  if (!hasMetricValue(metric.key, metric.value)) return { state: 'unknown', signal: null, statusLabel: 'Sem dados' };
  if (signal) return { state: signal.state, signal, statusLabel: HEALTH_STATES[signal.state].label };
  return { state: 'neutral', signal: null, statusLabel: 'Leitura atual válida' };
}
function orbitMetrics(server) {
  const health = healthOf(server);
  const severityOrder = { critical: 0, warning: 1, neutral: 2, unknown: 3 };
  return serverMetricGroups(visibleMetrics(server)).flatMap(group => group.items.map(item => ({ ...item, group: group.title, groupSubtitle: group.subtitle })))
    .map(item => ({ ...item, ...metricState(item, health) }))
    .sort((a, b) => severityOrder[a.state] - severityOrder[b.state] || a.label.localeCompare(b.label, 'pt-BR'));
}
function orbitStyle(index, focus, total, state) {
  const relative = ((index - focus + total) % total);
  const angle = (relative / total) * Math.PI * 2 - Math.PI / 2;
  const depth = Math.round(Math.sin(angle) * 100);
  const x = Math.round(Math.cos(angle) * 44);
  const y = Math.round(Math.sin(angle) * 34);
  const prominence = (depth + 100) / 200;
  const important = state === 'critical' || state === 'warning';
  const scale = (0.52 + prominence * 0.43 + (important ? 0.08 : 0)).toFixed(2);
  return `--orbit-x:${x}%;--orbit-y:${y}%;--orbit-depth:${depth}px;--orbit-scale:${scale};--orbit-order:${Math.round(depth + (important ? 20 : 0))}`;
}
function metricOrbit(server) {
  const metrics = orbitMetrics(server);
  if (!metrics.length) return '<section class="metric-orbit empty-orbit"><p>Sem métricas disponíveis para a órbita.</p></section>';
  let focus = metrics.findIndex(metric => metric.key === orbitFocusMetricKey);
  if (focus < 0) focus = 0;
  const featured = metrics[focus];
  const featuredValue = hasMetricValue(featured.key, featured.value)
    ? (PI_TEXT_METRICS.has(featured.key) ? String(featured.value) : format(featured.value, featured.digits))
    : '—';
  const severity = featured.state === 'neutral' ? 'Normal' : featured.statusLabel;
  const bubbleMarkup = metrics.map((metric, index) => {
    const value = hasMetricValue(metric.key, metric.value) ? (PI_TEXT_METRICS.has(metric.key) ? String(metric.value) : format(metric.value, metric.digits)) : '—';
    const priority = metric.state === 'critical' || metric.state === 'warning';
    return `<button type="button" class="orbit-bubble ${metric.state}${priority ? ' priority' : ''}" data-orbit-metric="${escapeHtml(metric.key)}" data-metric="${escapeHtml(metric.key)}" style="${orbitStyle(index, focus, metrics.length, metric.state)}" aria-label="${escapeHtml(metric.label)}: ${escapeHtml(value)}${metric.unit ? ` ${escapeHtml(metric.unit)}` : ''}; ${escapeHtml(metric.label === featured.label ? 'em foco' : 'trazer ao foco')}"><span>${escapeHtml(metric.label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(metric.unit || metric.groupSubtitle)}</small></button>`;
  }).join('');
  return `<section class="metric-orbit" aria-label="Órbita de 26 métricas de ${escapeHtml(server.name)}"><div class="orbit-heading"><div><span>ÓRBITA OPERACIONAL</span><h2>26 métricas em contexto</h2></div><p>${paused ? 'Órbita pausada' : 'Foco atualizado a cada 4 s'}</p></div><div class="orbit-stage" data-orbit-motion="${paused ? 'paused' : 'active'}"><div class="orbit-path orbit-path-back" aria-hidden="true"></div><div class="orbit-path orbit-path-front" aria-hidden="true"></div><div class="orbit-bubbles" aria-label="Selecione uma métrica para trazê-la ao foco">${bubbleMarkup}</div><article class="orbit-focus ${featured.state}" aria-live="polite"><span class="orbit-focus-eyebrow" data-orbit-focus-group>${escapeHtml(featured.group)} · ${escapeHtml(severity)}</span><h3 data-orbit-focus-name>${escapeHtml(featured.label)}</h3><strong data-orbit-focus-value>${escapeHtml(featuredValue)}<small>${hasMetricValue(featured.key, featured.value) ? escapeHtml(featured.unit || '') : ''}</small></strong><p data-orbit-focus-context>${escapeHtml(featured.groupSubtitle)} · ${hasMetricValue(featured.key, featured.value) ? escapeHtml(severity) : 'Estado não confirmado'}</p></article></div><p class="orbit-caption">Métricas críticas e de atenção recebem prioridade visual. Valores sem qualidade, vencidos ou ausentes permanecem como Sem dados.</p></section>`;
}
function refreshOrbitInPlace() {
  const stage = main.querySelector?.('.orbit-stage');
  const server = SERVERS[carouselIndex];
  if (!stage || !server) return false;
  const metrics = orbitMetrics(server);
  const focus = metrics.findIndex(metric => metric.key === orbitFocusMetricKey);
  if (focus < 0) return false;
  for (const [index, metric] of metrics.entries()) {
    const bubble = stage.querySelector?.(`[data-orbit-metric="${metric.key}"]`);
    if (!bubble) return false;
    const value = hasMetricValue(metric.key, metric.value) ? (PI_TEXT_METRICS.has(metric.key) ? String(metric.value) : format(metric.value, metric.digits)) : '—';
    const priority = metric.state === 'critical' || metric.state === 'warning';
    bubble.className = `orbit-bubble ${metric.state}${priority ? ' priority' : ''}`;
    bubble.style.cssText = orbitStyle(index, focus, metrics.length, metric.state);
    bubble.setAttribute('aria-label', `${metric.label}: ${value}${metric.unit ? ` ${metric.unit}` : ''}; ${metric.key === orbitFocusMetricKey ? 'em foco' : 'trazer ao foco'}`);
  }
  const featured = metrics[focus];
  const severity = featured.state === 'neutral' ? 'Normal' : featured.statusLabel;
  const reading = hasMetricValue(featured.key, featured.value) ? (PI_TEXT_METRICS.has(featured.key) ? String(featured.value) : format(featured.value, featured.digits)) : '—';
  const panel = stage.querySelector?.('.orbit-focus');
  if (!panel) return false;
  panel.className = `orbit-focus ${featured.state}`;
  const group = panel.querySelector?.('[data-orbit-focus-group]');
  const name = panel.querySelector?.('[data-orbit-focus-name]');
  const valueNode = panel.querySelector?.('[data-orbit-focus-value]');
  const context = panel.querySelector?.('[data-orbit-focus-context]');
  if (!group || !name || !valueNode || !context) return false;
  group.textContent = `${featured.group} · ${severity}`;
  name.textContent = featured.label;
  valueNode.textContent = reading;
  const unit = document.createElement?.('small');
  if (unit && hasMetricValue(featured.key, featured.value)) {
    unit.textContent = featured.unit || '';
    valueNode.append(unit);
  }
  context.textContent = `${featured.groupSubtitle} · ${hasMetricValue(featured.key, featured.value) ? severity : 'Estado não confirmado'}`;
  return true;
}
function donutMetric(server, key, label, unit, digits, health) {
  const value = currentMetric(server, key);
  const signal = health.signals.filter(item => item.metric === key).sort((a, b) => HEALTH_STATES[a.state].priority - HEALTH_STATES[b.state].priority)[0];
  const state = !Number.isFinite(value) ? 'unknown' : signal?.state || 'neutral';
  return { key, label, unit, digits, value, state, labelState: !Number.isFinite(value) ? 'Sem dados' : signal ? HEALTH_STATES[state].label : 'Sem alarme' };
}
function serverDonut(server) {
  const health = healthOf(server);
  const metrics = [
    donutMetric(server, 'runCPU', 'CPU', '%', 1, health),
    donutMetric(server, 'runMemory', 'RAM', '%', 1, health),
    donutMetric(server, 'runErrorsPerMinute', 'Erros de scripts', '/min', 1, health)
  ];
  const active = health.signals.filter(signal => ['critical', 'warning'].includes(signal.state)).length;
  const colors = metrics.map(metric => `--${metric.key}:${metric.state === 'critical' ? 'var(--critical)' : metric.state === 'warning' ? 'var(--warning)' : metric.state === 'unknown' ? 'var(--unknown)' : 'var(--cyan)'}`).join(';');
  const legend = metrics.map(metric => `<li class="donut-legend-item ${metric.state}" data-donut-metric="${metric.key}"><span class="donut-swatch" aria-hidden="true"></span><span>${escapeHtml(metric.label)}<small>${escapeHtml(metric.labelState)}</small></span><strong>${Number.isFinite(metric.value) ? escapeHtml(format(metric.value, metric.digits)) : '—'}<em>${Number.isFinite(metric.value) ? escapeHtml(metric.unit) : 'Sem dados'}</em></strong></li>`).join('');
  return `<article class="server-donut ${health.state}" data-donut-server="${escapeHtml(server.id)}"><div class="donut-server-heading"><div><span>ESTADO DO SERVIDOR</span><h3>${escapeHtml(server.name)}</h3></div>${statusBadge(health.state)}</div><div class="donut-layout"><div class="donut-chart" style="${colors}" role="img" aria-label="CPU, RAM e erros de scripts têm setores equivalentes; as cores indicam o estado"><div><strong>${active}</strong><span>${active === 1 ? 'alerta ativo' : 'alertas ativos'}</span></div></div><ul class="donut-legend">${legend}</ul></div><a href="#server/${encodeURIComponent(server.id)}" class="donut-details">Ver detalhes <span aria-hidden="true">↗</span></a></article>`;
}
function serverDonuts() {
  return `<section class="server-donuts" aria-label="Resumo de CPU, RAM e erros por servidor"><div class="donut-section-heading"><div><span>VISÃO DA FROTA</span><h2>CPU, RAM e erros de scripts</h2></div><p>Setores equivalentes; a cor representa a severidade.</p></div><div class="donut-grid">${SERVERS.map(serverDonut).join('')}</div></section>`;
}
function renderFleet() {
  if (!SERVERS.length) {
    main.innerHTML = '<div class="empty-state">Aguardando servidores.</div>';
    return;
  }
  carouselIndex = ((carouselIndex % SERVERS.length) + SERVERS.length) % SERVERS.length;
  const server = SERVERS[carouselIndex];
  document.getElementById('metric-page-controls').innerHTML = '';
  main.innerHTML = `<section class="server-carousel orbit-dashboard" aria-label="Visão geral dos servidores">${fleetNavigation()}<div class="metric-server-identity"><div><span>ÓRBITA ATIVA</span><h1>${escapeHtml(server.name)}</h1><small>${escapeHtml([server.site, server.environment].filter(Boolean).join(' · '))}</small></div><div class="carousel-controls"><a class="back-link" href="#server/${encodeURIComponent(server.id)}">Detalhes ↗</a><button id="carousel-previous" type="button" aria-label="Servidor anterior">←</button><button id="carousel-pause" class="carousel-pause" type="button" aria-pressed="${carouselPaused}" aria-label="${carouselPaused ? 'Retomar troca automática entre servidores' : 'Pausar troca automática entre servidores'}">${carouselPaused ? 'Retomar carrossel' : 'Pausar carrossel'}</button><button id="carousel-next" type="button" aria-label="Próximo servidor">→</button></div></div>${metricOrbit(server)}<aside id="overview-monitoring" aria-label="Alarmes ativos e histórico">${monitoringPanel()}</aside>${serverDonuts()}<p class="carousel-caption"><span>26 pontos na órbita</span><span>${!server.collecting ? 'Sem dados recentes · ' : ''}${paused ? 'Atualização pausada · ' : ''}${carouselPaused ? 'Carrossel pausado · ' : ''}Amostra: ${sampleAge(server)}</span></p></section>`;
}
function advanceCarousel() {
  if (paused || carouselPaused || activeServerId || !SERVERS.length || !document.getElementById('carousel-next')) return;
  monitoringPage++;
  renderFleet();
}
function advanceOrbit() {
  if (paused || activeServerId || !SERVERS.length || prefersReducedMotion()) return;
  const metrics = orbitMetrics(SERVERS[carouselIndex]);
  if (!metrics.length) return;
  const index = metrics.findIndex(metric => metric.key === orbitFocusMetricKey);
  orbitFocusMetricKey = metrics[(index + 1 + metrics.length) % metrics.length].key;
  if (!refreshOrbitInPlace()) renderFleet();
}
function prefersReducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}
function metricCards(metrics, health = {signals: []}) {
  return metrics.map((m, index) => {
    const available = hasMetricValue(m.key, m.value);
    const text = PI_TEXT_METRICS.has(m.key);
    const reading = !available ? '—' : text ? String(m.value) : format(m.value, Number(m.digits || 0));
    const signal = health.signals.filter(signal => signal.metric === m.key).sort((a,b) => HEALTH_STATES[a.state].priority - HEALTH_STATES[b.state].priority)[0];
    const state = !available ? 'unknown' : signal?.state || 'neutral';
    const label = !available ? 'Sem dados' : state === 'unknown' ? 'Análise pendente' : signal ? HEALTH_STATES[state].label : '';
    const indicator = available && m.unit === '%' ? `<div class="metric-indicator" aria-hidden="true"><i style="width:${Math.min(100, Math.max(0, m.value))}%"></i></div>` : '';
    const marker = label ? contextIcon(state === 'unknown' ? 'unknown' : signal?.kind === 'absolute' ? 'absolute' : 'trend') : '';
    return `<article class="metric-card ${state} ${text ? 'text-metric' : ''}" data-metric="${m.key}" style="--server-card-delay:${(index * -.42).toFixed(2)}s"><div class="card-heading"><span>${escapeHtml(m.label)}</span>${label ? `<span class="metric-status">${marker}${label}</span>` : ''}</div><div class="metric-body"><strong class="metric-value" title="${escapeHtml(reading)}">${escapeHtml(reading)}<em>${available ? escapeHtml(m.unit || '') : ''}</em></strong></div>${indicator}</article>`;
  }).join('');
}
function serverMetricGroups(m) {
  const card = (key, label, unit = '', digits = 0, detail = '') => ({key, label, value:m[key], unit, digits, detail, icon:'▣'});
  return [
    {title:'PERFORMANCE', subtitle:'E3RUN / SISTEMA', items:[
      card('runCPU','CPU · E3Run','%',1), card('runMemory','Memória · Sistema','%',1),
      card('runPVT','Memória privada · E3Run','KiB'), card('runTRD','Threads · E3Run'),
      card('runHDL','Handles · E3Run'), card('runPageFaults','Page faults · E3Run','',0,'Valor publicado; não é taxa calculada')]},
    {title:'SCRIPTS E EXECUÇÃO', subtitle:'E3RUN', items:[
      card('runOccupancy','Ocupação · Scripts','%',1), card('runErrorsPerMinute','Erros · Scripts','/min',1),
      card('runErrors','Erros acumulados'), card('runAvgScriptTime','Tempo médio · Script','',3,'Unidade publicada no PI'),
      card('runUptimeMinutes','Tempo em execução','min',1)]},
    {title:'EVENTOS LOCAIS', subtitle:'FILA LOCAL', items:[
      card('runLocalPending','Pendentes · Local'), card('runDiscardedEvents','Eventos descartados','',0,'Contador publicado; não é percentual')]},
    {title:'EVENTOS REMOTOS', subtitle:'FILA REMOTA', items:[
      card('runRemotePending','Pendentes · Remoto'), card('remoteHandledRate','Tratados · Remoto','/min',1),
      card('remoteDiscardedRate','Descartados · Remoto','/min',2), card('remoteDiscardPercent','Descarte · Remoto','%',2)]},
    {title:'SERVIDOR', subtitle:'E3SERVER', items:[
      card('serverCPU','CPU · E3Server','%',1), card('serverHDL','Handles · E3Server'),
      card('serverPVT','Memória privada · E3Server','KiB'), card('serverStatus','Status · E3Server','',0,'Estado publicado; sem classificação presumida')]},
    {title:'COLETA E E/S', subtitle:'PI', items:[
      card('collectionTimestamp','Timestamp da coleta','',0,'Valor da tag CollectionTimeStamp'),
      card('fileRead','Arquivo lido','',0,'Valor da tag FileRead'),
      card('totalTime','Tempo total','s',3), card('ioQueuePending','Fila de E/S · Pendentes'),
      card('ioQueueAvgDelay','Fila de E/S · Atraso médio','',3,'Unidade publicada no PI')]}
  ];
}
function metricSections(groups, health) {
  return groups.map(group => `<section class="metric-section" aria-label="${escapeHtml(group.title)}"><h2>${escapeHtml(group.title)} <span>${escapeHtml(group.subtitle)}</span></h2><div class="metric-grid">${metricCards(group.items, health)}</div></section>`).join('');
}
function topologyRisk(health) {
  return ['critical', 'warning', 'unknown'].includes(health.state) ? health.state : 'healthy';
}
function topologyModel() {
  const positions = [[22, 48], [50, 25], [78, 65], [50, 78], [50, 48]];
  const nodes = SERVERS.map((server, index) => {
    const health = healthOf(server);
    const position = positions[index % 3];
    const simulated = PI_DATA_STATE.simulated === true;
    return { id: server.id, label: server.name, type: 'Servidor de aplicação', zone: simulated ? 'SCADA (simulado)' : 'Não classificada', level: simulated ? 'L2 (simulado)' : 'Não informado', risk: topologyRisk(health), health, server, x: position[0], y: position[1], depth: [16, 54, -12][index % 3], delay: index * -1.7 };
  });
  // The production status contract has no network-session field. Demonstrative
  // sessions are exposed only by the isolated local preview, never inferred from PI values.
  const sessions = PI_DATA_STATE.simulated && nodes.length > 1 ? [
    { id: 'demo-1', source: nodes[0]?.id, target: nodes[1]?.id, protocol: 'OPC UA', port: '4840', risk: nodes[0]?.risk === 'critical' || nodes[1]?.risk === 'critical' ? 'critical' : 'warning', direction: '→', observed: 'Fluxo demonstrativo' },
    { id: 'demo-2', source: nodes[1]?.id, target: nodes[2]?.id, protocol: 'Modbus TCP', port: '502', risk: nodes[2]?.risk === 'critical' ? 'critical' : 'neutral', direction: '→', observed: 'Fluxo demonstrativo' }
  ].filter(session => session.source && session.target) : [];
  return { nodes, sessions, simulated: PI_DATA_STATE.simulated === true };
}
function topologySignature(model) {
  return JSON.stringify({ simulated: model.simulated, filters: topologyFilters, nodes: model.nodes.map(node => [node.id, node.label, node.risk]), sessions: model.sessions.map(session => [session.id, session.risk, session.protocol]) });
}
function filteredTopology(model) {
  const matchesRisk = item => topologyFilters.risk === 'all' || item.risk === topologyFilters.risk;
  const nodes = model.nodes.filter(node => (topologyFilters.zone === 'all' || node.zone === topologyFilters.zone) && matchesRisk(node));
  const ids = new Set(nodes.map(node => node.id));
  const sessions = model.sessions.filter(session => ids.has(session.source) && ids.has(session.target) && (topologyFilters.protocol === 'all' || session.protocol === topologyFilters.protocol) && matchesRisk(session));
  return { nodes, sessions };
}
function topologyFiltersPanel(model) {
  const risks = [['all', 'Todos os riscos'], ['critical', 'Crítico'], ['warning', 'Atenção'], ['unknown', 'Não confirmado']];
  const protocols = ['all', ...new Set(model.sessions.map(session => session.protocol))];
  const zones = ['all', ...new Set(model.nodes.map(node => node.zone))];
  return `<aside class="topology-filters" aria-label="Filtros de topologia"><div><span class="topology-panel-eyebrow">ESCOPO</span><h2>Filtros</h2><p>Reduza o mapa antes de investigar.</p></div><label>Zona<select data-topology-filter="zone">${zones.map(zone => `<option value="${escapeHtml(zone)}"${topologyFilters.zone === zone ? ' selected' : ''}>${zone === 'all' ? 'Todas as zonas' : escapeHtml(zone)}</option>`).join('')}</select></label><label>Protocolo<select data-topology-filter="protocol">${protocols.map(protocol => `<option value="${escapeHtml(protocol)}"${topologyFilters.protocol === protocol ? ' selected' : ''}>${protocol === 'all' ? 'Todos os protocolos' : escapeHtml(protocol)}</option>`).join('')}</select></label><label>Risco<select data-topology-filter="risk">${risks.map(([value, label]) => `<option value="${value}"${topologyFilters.risk === value ? ' selected' : ''}>${label}</option>`).join('')}</select></label><div class="topology-filter-note"><span aria-hidden="true">i</span><p>${model.simulated ? 'Fluxos demonstrativos locais; não representam sessões do PI Data Archive.' : 'A API atual não envia sessões, zonas ou níveis OT. Nenhuma comunicação foi inferida.'}</p></div></aside>`;
}
function topologyNode(node) {
  return `<button type="button" class="topology-node ${node.risk}" data-topology-node="${escapeHtml(node.id)}" style="--topology-x:${node.x}%;--topology-y:${node.y}%;--topology-depth:${node.depth}px;--topology-delay:${node.delay}s" aria-pressed="${topologySelectedId === node.id}" aria-label="${escapeHtml(node.label)} · ${escapeHtml(node.zone)} · ${escapeHtml(HEALTH_STATES[node.health.state].label)}"><span class="topology-node-icon" aria-hidden="true">▣</span><strong>${escapeHtml(node.label)}</strong><small>${escapeHtml(node.type)}</small><i aria-hidden="true"></i></button>`;
}
function topologyEdge(session, model) {
  const source = model.nodes.find(node => node.id === session.source);
  const target = model.nodes.find(node => node.id === session.target);
  if (!source || !target) return '';
  const midX = (source.x + target.x) / 2;
  const midY = (source.y + target.y) / 2;
  return `<g class="topology-edge ${session.risk}" data-topology-session="${escapeHtml(session.id)}"><line x1="${source.x}" y1="${source.y}" x2="${target.x}" y2="${target.y}" marker-end="url(#topology-arrow)"/><text x="${midX}" y="${midY - 2}">${escapeHtml(session.protocol)} · ${escapeHtml(session.port)}</text></g>`;
}
function topologyDetail(node, model) {
  if (!node) return `<aside class="topology-detail empty" aria-label="Detalhe do ativo"><span class="topology-panel-eyebrow">DETALHE CONTEXTUAL</span><h2>Selecione um ativo</h2><p>O painel mostrará zona, criticidade e sessões visíveis para o ativo escolhido.</p></aside>`;
  const sessions = model.sessions.filter(session => session.source === node.id || session.target === node.id);
  const active = node.health.signals.filter(signal => ['critical', 'warning'].includes(signal.state)).length;
  const communication = sessions.length ? `<ul class="topology-session-list">${sessions.map(session => `<li class="${session.risk}"><span>${escapeHtml(session.protocol)} · ${escapeHtml(session.port)}</span><strong>${escapeHtml(session.direction)}</strong><small>${escapeHtml(session.observed)}</small></li>`).join('')}</ul>` : '<p class="topology-no-sessions">Sem sessões de rede no contrato atual. Estado de comunicação não confirmado.</p>';
  return `<aside class="topology-detail ${node.risk}" aria-label="Detalhe de ${escapeHtml(node.label)}"><div class="topology-detail-heading"><div><span class="topology-panel-eyebrow">ATIVO SELECIONADO</span><h2>${escapeHtml(node.label)}</h2><p>${escapeHtml(node.type)}</p></div>${statusBadge(node.health.state)}</div><dl class="topology-facts"><div><dt>Zona</dt><dd>${escapeHtml(node.zone)}</dd></div><div><dt>Nível</dt><dd>${escapeHtml(node.level)}</dd></div><div><dt>Alertas ativos</dt><dd>${active}</dd></div><div><dt>Amostra</dt><dd>${escapeHtml(sampleAge(node.server))}</dd></div></dl><section><h3>Comunicações visíveis</h3>${communication}</section><a href="#server/${encodeURIComponent(node.id)}" class="topology-detail-link">Abrir métricas do servidor ↗</a></aside>`;
}
function renderTopology() {
  const model = topologyModel();
  topologyLastSignature = topologySignature(model);
  const { nodes, sessions } = filteredTopology(model);
  const selected = nodes.find(node => node.id === topologySelectedId) || null;
  if (!selected) topologySelectedId = null;
  const emptyState = !model.simulated ? '<div class="topology-empty-state"><strong>Estado de sessões não confirmado</strong><span>O monitoramento atual fornece ativos de aplicação, mas não telemetria de rede.</span></div>' : !nodes.length ? '<div class="topology-empty-state"><strong>Nenhum ativo corresponde aos filtros</strong><span>Ajuste zona, protocolo ou risco para ampliar o escopo.</span></div>' : '';
  const zoneLabel = model.simulated ? 'SCADA SIMULADO · L2' : 'GRUPO DE MONITORAMENTO';
  const motion = paused || prefersReducedMotion() ? 'paused' : 'active';
  main.innerHTML = `<section class="topology-workspace" aria-label="Topologia de rede OT">${topologyFiltersPanel(model)}<section class="topology-center"><header class="topology-header"><div><span class="topology-panel-eyebrow">TOPOLOGIA OT</span><h1>Contexto de segmentação</h1><p>${model.simulated ? 'Prévia local com fluxos demonstrativos.' : 'Ativos monitorados; sessões de comunicação aguardando uma fonte de telemetria de rede.'}</p></div><div class="topology-summary"><span>${nodes.length} ${nodes.length === 1 ? 'ativo visível' : 'ativos visíveis'}</span><strong>${sessions.length} ${sessions.length === 1 ? 'sessão' : 'sessões'}</strong></div></header><div class="topology-legend" aria-label="Legenda"><span class="healthy"><i></i>Conforme</span><span class="warning"><i></i>Atenção</span><span class="critical"><i></i>Crítico</span><span class="unknown"><i></i>Não confirmado</span></div><div class="topology-canvas" data-topology-motion="${motion}"><div class="topology-motion-plane"><svg class="topology-links" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><defs><marker id="topology-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 z"/></marker></defs><rect x="7" y="10" width="86" height="78" rx="4" class="topology-zone"/>${sessions.map(session => topologyEdge(session, model)).join('')}</svg><span class="topology-zone-label">${zoneLabel}</span>${nodes.map(topologyNode).join('')}${emptyState}</div></div><footer class="topology-canvas-footer"><span>Linhas representam sessões somente quando fornecidas pela fonte de telemetria.</span><button type="button" data-topology-reset>Limpar seleção</button></footer></section>${topologyDetail(selected, model)}</section>`;
}
function renderDetail(server) {
  const health = healthOf(server), groups = serverMetricGroups(visibleMetrics(server));
  const metadata = [server.site, server.environment, server.role].filter(Boolean).map(escapeHtml).join(' · ');
  const available = groups.flatMap(group => group.items).filter(item => hasMetricValue(item.key,item.value)).length;
  const pages = ['Runtime e scripts', 'Eventos', 'Servidor e coleta'];
  detailMetricPage = ((detailMetricPage % pages.length) + pages.length) % pages.length;
  const alarmPages = Math.max(1, Math.ceil(health.signals.length / 2));
  detailAlarmPage = ((detailAlarmPage % alarmPages) + alarmPages) % alarmPages;
  renderMetricPageControls(pages, detailMetricPage, true);
  const serverMotion = paused || prefersReducedMotion() ? 'paused' : 'active';
  main.innerHTML = `<section class="server-detail-carousel" data-server-motion="${serverMotion}"><div class="overview"><div><a href="#overview" class="back-link">← Todos os servidores</a><h1>${escapeHtml(server.name)}<span>.</span></h1><p>${metadata}</p></div>${statusBadge(health.state)}</div>${serverAlarmPanel(server,health,2,detailAlarmPage)}<p class="metric-summary">${available} de 26 pontos com dados válidos recentes · Amostra essencial: ${sampleAge(server)} · Valores sem qualidade ou vencidos aparecem como —</p><div class="primary-grid detail-metrics all-metrics">${metricSections(groups.slice(detailMetricPage * 2, detailMetricPage * 2 + 2), health)}</div></section>`;
}
function renderRoute(moveFocus = false) {
  const isTopology = location.hash === '#topology';
  document.body?.classList.toggle('overview-page', !location.hash.startsWith('#server/') && !isTopology);
  document.body?.classList.toggle('detail-page', location.hash.startsWith('#server/'));
  document.body?.classList.toggle('topology-page', isTopology);
  const hash = location.hash.slice(1);
  let id = null;
  try { if (hash.startsWith('server/')) id = decodeURIComponent(hash.slice(7)); } catch { id = '__invalid__'; }
  const server = SERVERS.find(item => item.id === id);
  activeServerId = server?.id || null;
  document.getElementById('server-select').value = activeServerId || '';
  document.getElementById('fleet-link').setAttribute('aria-current', !id && !isTopology ? 'page' : 'false');
  document.getElementById('topology-link').setAttribute('aria-current', isTopology ? 'page' : 'false');
  if (id && !server) {
    main.innerHTML = '<div class="empty-state"><h1>Servidor não encontrado</h1><p>Este identificador não pertence ao inventário configurado.</p><a class="back-link" href="#overview">← Voltar à visão geral</a></div>';
    document.title = 'Runtime Monitor — Servidor não encontrado';
  } else if (server) { renderDetail(server); document.title = `Runtime Monitor — ${server.name}`; }
  else if (isTopology) { document.getElementById('metric-page-controls').innerHTML = ''; renderTopology(); document.title = 'Runtime Monitor — Topologia OT'; }
  else { renderFleet(); document.title = 'Runtime Monitor — Visão geral'; }
  if (moveFocus) { main.focus({ preventScroll: true }); window.scrollTo(0, 0); }
}
function renderConnectionState() {
  const state = PI_DATA_STATE;
  const adapter = state.simulated ? 'SIMULAÇÃO LOCAL' : state.source === 'af-sdk' ? 'AF SDK' : 'PI SDK COM';
  document.getElementById('footer-source').textContent = state.simulated ? 'Simulação local · sem comunicação PI' : state.source ? `PI Data Archive · ${adapter}` : 'PI Data Archive · aguardando conexão';
  document.getElementById('source-badge').textContent = state.status === 'connected' ? `${adapter} · CONECTADO` : state.status === 'not-configured' ? 'PI · NÃO CONFIGURADO' : state.status === 'degraded' ? `${adapter} · DADOS PARCIAIS` : `${adapter} · SEM CONEXÃO`;
  document.getElementById('source-badge').setAttribute('data-state', paused ? 'paused' : state.simulated ? 'simulated' : state.status);
  document.getElementById('connection-status').textContent = paused ? 'Atualização pausada' : state.message;
  document.getElementById('updated').textContent = state.lastSuccess ? `Resposta às ${new Date(state.lastSuccess).toLocaleTimeString('pt-BR')}` : 'Aguardando dados';
}
function renderDataUpdate() {
  const focus = document.activeElement;
  const id = focus?.id;
  const selection = id === 'server-search' ? [focus.selectionStart, focus.selectionEnd] : null;
  const select = document.getElementById('server-select');
  select.innerHTML = '<option value="">Selecionar servidor</option>' + SERVERS.map(server => `<option value="${escapeHtml(server.id)}">${escapeHtml(server.name)} · ${escapeHtml(server.site)}</option>`).join('');
  if (location.hash === '#topology') {
    const model = topologyModel();
    if (topologyLastSignature !== topologySignature(model)) renderTopology();
  } else renderRoute();
  renderConnectionState();
  if (id && document.getElementById(id)) {
    const target = document.getElementById(id);
    target.focus({ preventScroll: true });
    if (selection && selection.every(Number.isInteger)) target.setSelectionRange(...selection);
  }
}
document.getElementById('server-select').addEventListener('change', event => { location.hash = event.target.value ? `server/${encodeURIComponent(event.target.value)}` : 'overview'; });
document.getElementById('metric-page-controls').addEventListener('click', event => {
  const detailMetricPageButton = event.target.closest('[data-detail-metric-page]');
  if (detailMetricPageButton && activeServerId) {
    detailMetricPage = Number(detailMetricPageButton.dataset.detailMetricPage);
    renderDetail(SERVERS.find(server => server.id === activeServerId));
    document.getElementById(detailMetricPageButton.id)?.focus({ preventScroll: true });
    return;
  }
  const metricPage = event.target.closest('[data-metric-page]');
  if (metricPage) {
    overviewMetricPage = Number(metricPage.dataset.metricPage);
    renderFleet();
    document.getElementById(metricPage.id)?.focus({ preventScroll: true });
  }
});
document.getElementById('pause').addEventListener('click', event => {
  paused = !paused;
  event.currentTarget.textContent = paused ? 'Retomar atualização' : 'Pausar atualização';
  event.currentTarget.setAttribute('aria-pressed', String(paused));
  renderRoute();
  renderConnectionState();
});
main.addEventListener('click', event => {
  const topologyNodeButton = event.target.closest('[data-topology-node]');
  if (topologyNodeButton) {
    topologySelectedId = topologyNodeButton.dataset.topologyNode;
    renderTopology();
    document.querySelector?.(`[data-topology-node="${topologySelectedId}"]`)?.focus({ preventScroll: true });
    return;
  }
  if (event.target.closest('[data-topology-reset]')) {
    topologySelectedId = null;
    renderTopology();
    return;
  }
  const orbitBubble = event.target.closest('[data-orbit-metric]');
  if (orbitBubble) {
    orbitFocusMetricKey = orbitBubble.dataset.orbitMetric;
    if (!refreshOrbitInPlace()) renderFleet();
    document.querySelector?.(`[data-orbit-metric="${orbitFocusMetricKey}"]`)?.focus({ preventScroll: true });
    return;
  }
  const detailAlarmPageButton = event.target.closest('[data-detail-alarm-page]');
  if (detailAlarmPageButton) { detailAlarmPage = Number(detailAlarmPageButton.dataset.detailAlarmPage); renderDetail(SERVERS.find(server => server.id === activeServerId)); return; }
  const detailMetricPageButton = event.target.closest('[data-detail-metric-page]');
  if (detailMetricPageButton) { detailMetricPage = Number(detailMetricPageButton.dataset.detailMetricPage); renderDetail(SERVERS.find(server => server.id === activeServerId)); return; }
  const metricPage = event.target.closest('[data-metric-page]');
  if (metricPage) { overviewMetricPage = Number(metricPage.dataset.metricPage); renderFleet(); return; }
  const button = event.target.closest('button');
  if (!button) return;
  if (button.id === 'carousel-pause') {
    carouselPaused = !carouselPaused;
    renderFleet();
    document.getElementById('carousel-pause')?.focus({ preventScroll: true });
    return;
  }
  if (button.id === 'carousel-previous') carouselIndex = (carouselIndex - 1 + SERVERS.length) % SERVERS.length;
  else if (button.id === 'carousel-next') carouselIndex = (carouselIndex + 1) % SERVERS.length;
  else if (button.dataset.carouselIndex !== undefined) carouselIndex = Number(button.dataset.carouselIndex);
  else return;
  renderFleet();
  (button.id ? document.getElementById(button.id) : document.querySelector(`button[data-carousel-index="${carouselIndex}"]`))?.focus({ preventScroll: true });
});
main.addEventListener('change', event => {
  const filter = event.target.closest('[data-topology-filter]');
  if (!filter) return;
  topologyFilters[filter.dataset.topologyFilter] = filter.value;
  renderTopology();
});
window.addEventListener('hashchange', () => renderRoute(true));
renderRoute(); renderConnectionState();
startDataSource(renderDataUpdate, () => paused);
setInterval(() => {
  const interacting = document.activeElement?.closest('#main a, #main button, #metric-page-controls button');
  if (paused || interacting) return;
  if (!paused && !activeServerId && location.hash !== '#topology') {
    advanceCarousel();
  } else if (activeServerId) {
    detailMetricPage = (detailMetricPage + 1) % 3;
    detailAlarmPage++;
    renderDetail(SERVERS.find(server => server.id === activeServerId));
  }
}, CAROUSEL_INTERVAL_MS);
setInterval(advanceOrbit, ORBIT_INTERVAL_MS);
setInterval(() => {
  if (document.activeElement?.closest('#main a, #main button, #metric-page-controls button')) return;
  if (location.hash === '#topology') {
    // The topology updates only when a visible state changes, preserving continuous 3D motion.
  } else if (activeServerId) {
    renderDetail(SERVERS.find(server => server.id === activeServerId));
  }
  else renderFleet();
  renderConnectionState();
}, 10000);
renderClock();
setInterval(renderClock, 1000);

