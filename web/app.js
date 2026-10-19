/* SCADA monitoring interface. */
'use strict';
const format = (value, digits = 0) => Number.isFinite(value) ? new Intl.NumberFormat('pt-BR', { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(value) : '—';
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const main = document.getElementById('main');
let paused = false;
let historyMinutes = 15;
let activeServerId = null;
let carouselIndex = 0;
let monitoringPage = 0;
const CAROUSEL_INTERVAL_MS = 10000;
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
const statusBadge = state => `<span class="health-badge ${state}"><i></i>${HEALTH_STATES[state].label}</span>`;
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
  return Number.isFinite(value) && (!quality || quality.good === true) && Number.isFinite(timestamp) && timestamp <= now && now - timestamp <= HEALTH_LIMITS.staleSeconds * 1000 ? value : null;
}
function visibleMetrics(server) { return Object.fromEntries(Object.keys(server.metrics || {}).map(key => [key, currentMetric(server, key)])); }
function serverAlarmPanel(server, health) {
  const points = { runCPU: ['E3Run.CPU', '%', 1], runMemory: ['Sistema.Memória', '%', 1], runPVT: ['E3Run.MemóriaPrivada', 'KiB', 0], runTRD: ['E3Run.Threads', 'threads', 0], runErrorsPerMinute: ['E3Run.ErrosScripts', 'erros/min', 1], runLocalPending: ['E3Run.FilaLocal', 'eventos', 0], runRemotePending: ['E3Run.FilaRemota', 'eventos', 0] };
  const activeCount = health.signals.filter(signal => ['critical', 'warning'].includes(signal.state)).length;
  const heading = activeCount ? `${activeCount} ${activeCount === 1 ? 'alarme ativo' : 'alarmes ativos'} neste servidor` : health.signals.length ? 'Diagnóstico dos alarmes' : 'Nenhum alarme ativo';
  const rows = health.signals.map(signal => {
    const active = ['critical', 'warning'].includes(signal.state);
    const [point, unit, digits] = points[signal.metric] || [signal.title, '', 0];
    const value = active && signal.metric ? currentMetric(server, signal.metric) : null;
    const condition = !signal.metric ? (active ? 'Falha de publicação' : 'Dados indisponíveis') : !active ? 'Dados ou histórico indisponíveis' : signal.kind === 'absolute' ? (unit === '%' ? 'Percentual Muito Alto' : 'Valor Muito Alto') : 'Tendência de Elevação';
    const reading = signal.metric && active ? ` (${format(value, digits)}${Number.isFinite(value) ? ` ${unit}` : ''})` : '';
    const text = `${point} - ${condition}${reading}`;
    return `<li class="detail-alarm ${signal.state}" title="${escapeHtml(signal.description || '')}"><span class="detail-alarm-icon" aria-hidden="true">${active ? '!' : '?'}</span><span class="detail-alarm-text">${escapeHtml(text)}</span><span class="detail-alarm-state">- ${active ? 'Ativo' : 'Indisponível'}</span></li>`;
  }).join('');
  return `<section class="server-alerts ${health.state}" aria-label="Alarmes do servidor"><strong>${heading}</strong>${rows ? `<ul class="detail-alarm-list">${rows}</ul>` : '<p>Nenhum limite ou tendência de elevação ativo.</p>'}</section>`;
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
  const signals = SERVERS.flatMap(server => healthOf(server).signals.map(signal => ({ ...signal, server })))
    .sort((a, b) => HEALTH_STATES[a.state].priority - HEALTH_STATES[b.state].priority || a.server.name.localeCompare(b.server.name));
  const pages = Math.max(1, Math.ceil(signals.length / 2));
  monitoringPage %= pages;
  const units = { runCPU: ['%', 1], runMemory: ['%', 1], runPVT: ['KiB', 0], runTRD: ['threads', 0], runErrorsPerMinute: ['/min', 1], runLocalPending: ['eventos', 0], runRemotePending: ['eventos', 0] };
  const labels = { runCPU: 'CPU', runMemory: 'RAM', runPVT: 'Memória privada', runTRD: 'Threads', runErrorsPerMinute: 'Erros', runLocalPending: 'Fila local', runRemotePending: 'Fila remota' };
  const cards = signals.slice(monitoringPage * 2, monitoringPage * 2 + 2).map(signal => {
    const [unit, digits] = units[signal.metric] || ['', 0];
    const value = signal.state === 'unknown' ? null : currentMetric(signal.server, signal.metric);
    const rate = signal.state === 'unknown' ? '' : signal.description.split(' · ')[0];
    const explanation = rate.replace(/^↑ (.+?) por minuto$/, 'Aumento de $1 ponto percentual por minuto');
    return `<a class="compact-alarm ${signal.state}" href="#server/${encodeURIComponent(signal.server.id)}" title="${escapeHtml(signal.description)}">${monitoringSeverityIcon(signal.state)}<div class="compact-alarm-top"><span>${escapeHtml(labels[signal.metric] || signal.title)}${signal.kind === 'absolute' ? ' · Limite' : ''}</span><span class="compact-alarm-state">${signal.stateLabel || HEALTH_STATES[signal.state].label}</span></div><strong>${format(value, digits)}${Number.isFinite(value) ? ` <small>${unit}</small>` : ''}</strong><span class="compact-alarm-rate" title="${escapeHtml(explanation)}">${escapeHtml(rate)}</span><span class="compact-alarm-server">${escapeHtml(signal.server.name)} <span>↗</span></span></a>`;
  }).join('');
  return `<div class="compact-monitor-heading"><h2>MONITORAMENTO</h2><span>${signals.filter(s => s.state === 'critical').length} críticos · ${signals.filter(s => s.state === 'warning').length} atenção · ${signals.filter(s => s.state === 'unknown').length} sem dados</span></div><div class="compact-alarm-list">${cards || '<p class="healthy">Nenhuma sinalização ativa</p>'}</div><p class="compact-monitor-caption">${signals.length ? `Página ${monitoringPage + 1} de ${pages}` : ''}</p>`;
}
function renderFleet() {
  if (!SERVERS.length) {
    main.innerHTML = '<div class="empty-state">Aguardando servidores.</div>';
    return;
  }
  carouselIndex = ((carouselIndex % SERVERS.length) + SERVERS.length) % SERVERS.length;
  const server = SERVERS[carouselIndex];
  const { performance, events } = serverMetricGroups(visibleMetrics(server));
  main.innerHTML = `<section class="server-carousel" aria-label="Carrossel de servidores"><div class="overview-top"><div class="carousel-identity"><p class="carousel-eyebrow">VISÃO GERAL · SERVIDOR ${carouselIndex + 1} DE ${SERVERS.length}</p><h1>${escapeHtml(server.name)}</h1><p>${escapeHtml(server.site)} · ${escapeHtml(server.environment)}</p><div class="carousel-controls"><a class="back-link" href="#server/${encodeURIComponent(server.id)}">Detalhes ↗</a><button id="carousel-previous" type="button" aria-label="Servidor anterior">←</button><button id="carousel-next" type="button" aria-label="Próximo servidor">→</button></div><div class="carousel-dots" aria-label="Selecionar servidor">${SERVERS.map((item, index) => `<button type="button" data-carousel-index="${index}" aria-label="Mostrar ${escapeHtml(item.name)}" aria-pressed="${index === carouselIndex}">${escapeHtml(item.name)}</button>`).join('')}</div></div><aside id="overview-monitoring" aria-label="Monitoramento de todos os servidores">${monitoringPanel()}</aside></div><div class="primary-grid carousel-metrics"><section aria-labelledby="performance-title"><h2 id="performance-title">PERFORMANCE <span>E3RUN</span></h2><div class="metric-grid">${metricCards(performance)}</div></section><section aria-labelledby="events-title"><h2 id="events-title">EVENTOS <span>LOCAL / REMOTE</span></h2><div class="metric-grid">${metricCards(events)}</div></section></div><p class="carousel-caption">${!server.collecting ? 'Sem dados recentes · ' : ''}${paused ? 'Atualização pausada · ' : ''}Amostra: ${sampleAge(server)}</p></section>`;
}
function advanceCarousel() {
  if (paused || activeServerId || SERVERS.length < 2 || !document.getElementById('carousel-next')) return;
  carouselIndex = (carouselIndex + 1) % SERVERS.length;
  renderFleet();
}
function metricCards(metrics) {
  return metrics.map(m => `<article class="metric-card"><div class="card-heading">${m.label}</div><div class="metric-body"><span class="metric-icon" aria-hidden="true">${m.icon}</span><strong class="metric-value">${format(m.value, m.digits || 0)}<em>${Number.isFinite(m.value) ? m.unit || '' : ''}</em></strong></div><div class="metric-sub">${Number.isFinite(m.value) ? m.detail : 'Sem dados recentes'}</div>${m.progress && Number.isFinite(m.value) ? `<div class="mini-track" aria-hidden="true"><span style="width:${Math.max(0, Math.min(100, m.value))}%"></span></div>` : ''}</article>`).join('');
}
function chartSvg(kind, samples) {
  if (!samples.length) return '<div class="no-chart">Histórico PI ainda indisponível.</div>';
  const width = 600, height = 190, left = 43, right = 12, top = 12, bottom = 27;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const start = samples[0].timestamp, end = samples.at(-1).timestamp;
  const max = Math.ceil(Math.max(...samples.flatMap(item => [item.entered, item.handled])) / 200) * 200 || 200;
  const points = field => samples.map(item => `${(left + (item.timestamp - start) / (end - start || 1) * plotWidth).toFixed(1)},${(top + plotHeight - item[field] / max * plotHeight).toFixed(1)}`).join(' ');
  const grid = Array.from({ length: 5 }, (_, i) => { const y = top + i * plotHeight / 4; return `<line class="gridline" x1="${left}" x2="${width - right}" y1="${y}" y2="${y}"/><text x="${left - 8}" y="${y + 3}" text-anchor="end">${format(max * (1 - i / 4))}</text>`; }).join('');
  const times = Array.from({ length: 7 }, (_, i) => `<text x="${left + i * plotWidth / 6}" y="${height - 7}" text-anchor="middle">${new Date(start + i * (end - start) / 6).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</text>`).join('');
  const area = field => `${left},${top + plotHeight} ${points(field)} ${width - right},${top + plotHeight}`;
  return `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Histórico PI de eventos ${kind === 'local' ? 'locais' : 'remotos'} enfileirados e tratados por minuto"><defs><linearGradient id="${kind}-blue" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#56b7d4" stop-opacity=".3"/><stop offset="1" stop-color="#56b7d4" stop-opacity=".02"/></linearGradient><linearGradient id="${kind}-green" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#91d66a" stop-opacity=".3"/><stop offset="1" stop-color="#91d66a" stop-opacity=".02"/></linearGradient></defs>${grid}<polygon points="${area('entered')}" fill="url(#${kind}-blue)"/><polygon points="${area('handled')}" fill="url(#${kind}-green)"/><polyline points="${points('entered')}" fill="none" stroke="#56b7d4" stroke-width="1.5"/><polyline points="${points('handled')}" fill="none" stroke="#91d66a" stroke-width="1.5"/>${times}</svg>`;
}
function renderFlows() {
  document.querySelector('.flow-section')?.remove();
}
function uptime(minutes) { return Number.isFinite(minutes) ? `${Math.floor(minutes / 1440)} d ${Math.floor(minutes % 1440 / 60)} h ${minutes % 60} min` : '—'; }
function serverMetricGroups(m) {
  const performance = [
    { label: 'CPU · E3RUN', value: m.runCPU, unit: '%', digits: 1, icon: '▣', detail: 'Carga do processo', progress: true },
    { label: 'MEMÓRIA · SISTEMA', value: m.runMemory, unit: '%', digits: 1, icon: '▥', detail: 'MemoryLoad publicado no PI', progress: true },
    { label: 'MEMÓRIA PRIVADA', value: m.runPVT, unit: 'KiB', icon: '▤', detail: 'PVT do E3Run' },
    { label: 'THREADS · E3RUN', value: m.runTRD, icon: '⌘', detail: 'Threads em execução' },
    { label: 'FILA DE E/S', value: m.ioQueuePending, unit: 'pendentes', icon: '⌁', detail: `Atraso médio: ${format(m.ioQueueAvgDelay, 1)}` }
  ];
  const events = [
    { label: 'PENDENTES · LOCAL', value: m.runLocalPending, icon: '≋', detail: 'Eventos na fila local' },
    { label: 'PENDENTES · REMOTE', value: m.runRemotePending, icon: '≋', detail: 'Eventos na fila remota' },
    { label: 'OCUPAÇÃO · SCRIPTS', value: m.runOccupancy, unit: '%', digits: 1, icon: '⚙', detail: 'Ocupação do E3Run', progress: true },
    { label: 'ERROS · SCRIPTS', value: m.runErrorsPerMinute, unit: '/min', digits: 0, icon: '◇', detail: 'Taxa publicada no PI' }
  ];
  return { performance, events };
}
function renderDetail(server) {
  const health = healthOf(server), m = visibleMetrics(server), valid = server.collecting && Number.isFinite(server.sampleTime) && server.sampleTime <= Date.now() && Date.now() - server.sampleTime <= HEALTH_LIMITS.staleSeconds * 1000;
  const { performance, events } = serverMetricGroups(m);
  const metadata = [server.site, server.environment, server.role].filter(Boolean).map(escapeHtml).join(' <span class="metadata-separator">/</span> ');
  main.innerHTML = `<div class="overview"><div><a href="#overview" class="back-link">← Todos os servidores</a><h1>${escapeHtml(server.name)}<span>.</span></h1>${metadata ? `<p>${metadata}</p>` : ''}</div>${statusBadge(health.state)}</div>${serverAlarmPanel(server, health)}<div class="primary-grid"><section aria-labelledby="performance-title"><h2 id="performance-title">PERFORMANCE <span>E3RUN</span></h2><div class="metric-grid">${metricCards(performance)}</div></section><section aria-labelledby="events-title"><h2 id="events-title">EVENTOS <span>LOCAL / REMOTE</span></h2><div class="metric-grid">${metricCards(events)}</div></section><section aria-labelledby="process-title"><h2 id="process-title">PROCESSOS <span>STATUS</span></h2><div class="status-stack">${['E3RUN', 'E3SERVER'].map(process => `<article class="status-card"><div class="card-heading">${process} <span class="status-dot ${valid ? '' : 'unknown'}"></span></div><div class="process-info"><span class="process-icon">▣</span><span>${process === 'E3RUN' ? 'Runtime' : 'Servidor'}<small>${process === 'E3RUN' ? 'Processo de execução' : valid ? `CPU ${format(m.serverCPU, 1)}% · ${format(m.serverHDL)} handles` : 'Sem dados recentes'}</small></span></div><div class="status-banner ${valid ? '' : 'unknown'}">${valid ? 'MÉTRICAS DISPONÍVEIS NO PI' : 'ESTADO NÃO CONFIRMADO'}</div>${process === 'E3RUN' ? `<div class="status-bottom">Uptime <b>${uptime(m.runUptimeMinutes)}</b></div>` : ''}</article>`).join('')}</div></section><section aria-labelledby="quality-title"><h2 id="quality-title">COLETA <span>QUALIDADE</span></h2><div class="quality-card"><div class="card-heading">FONTE PI <span class="outline-label">${PI_DATA_STATE.simulated ? 'SIMULAÇÃO' : PI_DATA_STATE.source === 'af-sdk' ? 'AF SDK' : 'SDK COM'}</span></div><span class="quality-icon ${valid ? 'healthy' : 'unknown'}">${valid ? '✓' : '?'}</span><strong class="${health.state}">${valid ? 'AMOSTRA DISPONÍVEL' : 'SEM DADOS RECENTES'}</strong><p>${valid ? PI_DATA_STATE.simulated ? 'Amostras simuladas para avaliação' : 'Medições PI com qualidade válida' : 'Valores atuais não disponíveis'}</p><div class="quality-checks">${[['CPU', m.runCPU], ['RAM', m.runMemory], ['Erros', m.runErrorsPerMinute], ['Fila de E/S', m.ioQueuePending]].map(([label, value]) => `<span>${label} <b>${Number.isFinite(value) ? '✓' : '—'}</b></span>`).join('')}</div><dl><div><dt>Idade da amostra</dt><dd>${sampleAge(server)}</dd></div><div><dt>Tempo de leitura</dt><dd>${format(m.totalTime, 3)}${valid ? ' s' : ''}</dd></div><div><dt>Reset de contadores</dt><dd>—</dd></div></dl></div></section></div><section class="flow-section" aria-labelledby="flow-title"><div class="section-bar"><h2 id="flow-title">FLUXO DE EVENTOS · ${escapeHtml(server.name)}</h2><label>Janela do histórico <select id="window"><option value="15">Últimos 15 minutos</option><option value="30">Últimos 30 minutos</option><option value="60">Última hora</option></select></label></div><div class="flow-grid" id="flows"></div></section><section class="bottom-grid" aria-label="Recursos e informações da coleta"><article class="resource"><span class="resource-icon">▤</span><div><small>ESPAÇO LIVRE · C:</small><strong>${format(m.driveCFreeMB)} <em>${valid ? 'MB' : ''}</em></strong></div></article><article class="resource"><span class="resource-icon">⌁</span><div><small>FILA DE E/S</small><strong>${format(m.ioQueuePending)} <em>${valid ? 'pendentes' : ''}</em></strong></div><span class="resource-note">Atraso médio: ${format(m.ioQueueAvgDelay, 1)}</span></article><article class="resource"><span class="resource-icon">▧</span><div><small>ARQUIVO ETL</small><strong>${format(m.etlFileSizeMB, 1)} <em>${valid ? 'MB' : ''}</em></strong></div><span class="resource-note">Tamanho publicado no PI</span></article></section>`;
  main.querySelector('.bottom-grid')?.remove();
  renderFlows();
}
function renderRoute(moveFocus = false) {
  document.body?.classList.toggle('overview-page', !location.hash.startsWith('#server/'));
  const hash = location.hash.slice(1);
  let id = null;
  try { if (hash.startsWith('server/')) id = decodeURIComponent(hash.slice(7)); } catch { id = '__invalid__'; }
  const server = SERVERS.find(item => item.id === id);
  activeServerId = server?.id || null;
  document.getElementById('server-select').value = activeServerId || '';
  document.getElementById('fleet-link').setAttribute('aria-current', !id ? 'page' : 'false');
  if (id && !server) {
    main.innerHTML = '<div class="empty-state"><h1>Servidor não encontrado</h1><p>Este identificador não pertence ao inventário configurado.</p><a class="back-link" href="#overview">← Voltar à visão geral</a></div>';
    document.title = 'Runtime Monitor — Servidor não encontrado';
  } else if (server) { renderDetail(server); document.title = `Runtime Monitor — ${server.name}`; }
  else { renderFleet(); document.title = 'Runtime Monitor — Visão geral'; }
  if (moveFocus) { main.focus({ preventScroll: true }); window.scrollTo(0, 0); }
}
function renderConnectionState() {
  const state = PI_DATA_STATE;
  const adapter = state.simulated ? 'SIMULAÇÃO LOCAL' : state.source === 'af-sdk' ? 'AF SDK' : 'PI SDK COM';
  document.getElementById('footer-source').textContent = state.simulated ? 'Simulação local · sem comunicação PI' : state.source ? `PI Data Archive · ${adapter}` : 'PI Data Archive · aguardando conexão';
  document.getElementById('source-badge').textContent = state.status === 'connected' ? `${adapter} · CONECTADO` : state.status === 'not-configured' ? 'PI · NÃO CONFIGURADO' : state.status === 'degraded' ? `${adapter} · DADOS PARCIAIS` : `${adapter} · SEM CONEXÃO`;
  document.getElementById('connection-status').textContent = paused ? 'Atualização pausada' : state.message;
  document.getElementById('updated').textContent = state.lastSuccess ? `Resposta às ${new Date(state.lastSuccess).toLocaleTimeString('pt-BR')}` : 'Aguardando dados';
}
function renderDataUpdate() {
  const focus = document.activeElement;
  const id = focus?.id;
  const selection = id === 'server-search' ? [focus.selectionStart, focus.selectionEnd] : null;
  const select = document.getElementById('server-select');
  select.innerHTML = '<option value="">Selecionar servidor</option>' + SERVERS.map(server => `<option value="${escapeHtml(server.id)}">${escapeHtml(server.name)} · ${escapeHtml(server.site)}</option>`).join('');
  renderRoute();
  renderConnectionState();
  if (id && document.getElementById(id)) {
    const target = document.getElementById(id);
    target.focus({ preventScroll: true });
    if (selection && selection.every(Number.isInteger)) target.setSelectionRange(...selection);
  }
}
document.getElementById('server-select').addEventListener('change', event => { location.hash = event.target.value ? `server/${encodeURIComponent(event.target.value)}` : 'overview'; });
document.getElementById('pause').addEventListener('click', event => {
  paused = !paused;
  event.currentTarget.textContent = paused ? 'Retomar atualização' : 'Pausar atualização';
  event.currentTarget.setAttribute('aria-pressed', String(paused));
  renderConnectionState();
});
main.addEventListener('change', event => {
  if (event.target.id === 'window') { historyMinutes = Number(event.target.value); renderFlows(SERVERS.find(s => s.id === activeServerId)); }
});
main.addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.id === 'carousel-previous') carouselIndex = (carouselIndex - 1 + SERVERS.length) % SERVERS.length;
  else if (button.id === 'carousel-next') carouselIndex = (carouselIndex + 1) % SERVERS.length;
  else if (button.dataset.carouselIndex !== undefined) carouselIndex = Number(button.dataset.carouselIndex);
  else return;
  renderFleet();
  (button.id ? document.getElementById(button.id) : document.querySelector(`button[data-carousel-index="${carouselIndex}"]`))?.focus({ preventScroll: true });
});
window.addEventListener('hashchange', () => renderRoute(true));
renderRoute(); renderConnectionState();
startDataSource(renderDataUpdate, () => paused);
setInterval(() => {
  if (!paused && !activeServerId) {
    monitoringPage++;
    const panel = document.getElementById('overview-monitoring');
    if (panel) panel.innerHTML = monitoringPanel();
  }
  advanceCarousel();
}, CAROUSEL_INTERVAL_MS);
setInterval(() => {
  if (document.activeElement?.closest('#main')) return;
  if (activeServerId) renderDetail(SERVERS.find(server => server.id === activeServerId));
  else renderFleet();
  renderConnectionState();
}, 10000);
renderClock();
setInterval(renderClock, 1000);

