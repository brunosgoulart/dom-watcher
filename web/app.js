/* SCADA monitoring interface. */
'use strict';
const format = (value, digits = 0) => Number.isFinite(value) ? new Intl.NumberFormat('pt-BR', { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(value) : '—';
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const main = document.getElementById('main');
let paused = false;
let activeServerId = null;
let carouselIndex = 0;
let monitoringPage = 0;
let overviewMetricPage = 0;
let detailMetricPage = 0;
let detailAlarmPage = 0;
const CAROUSEL_INTERVAL_MS = 10000;
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
function renderFleet() {
  if (!SERVERS.length) {
    main.innerHTML = '<div class="empty-state">Aguardando servidores.</div>';
    return;
  }
  carouselIndex = ((carouselIndex % SERVERS.length) + SERVERS.length) % SERVERS.length;
  const server = SERVERS[carouselIndex];
  const groups = serverMetricGroups(visibleMetrics(server));
  const pages = ['Runtime e scripts', 'Eventos', 'Servidor e coleta'];
  overviewMetricPage = ((overviewMetricPage % pages.length) + pages.length) % pages.length;
  renderMetricPageControls(pages, overviewMetricPage);
  main.innerHTML = `<section class="server-carousel" aria-label="Carrossel de servidores">${fleetNavigation()}<aside id="overview-monitoring" aria-label="Alarmes ativos e histórico">${monitoringPanel()}</aside><div class="metric-server-identity"><div><span>MEDIÇÕES</span><h1>${escapeHtml(server.name)}</h1><small>${escapeHtml([server.site, server.environment].filter(Boolean).join(' · '))}</small></div><div class="carousel-controls"><a class="back-link" href="#server/${encodeURIComponent(server.id)}">Detalhes ↗</a><button id="carousel-previous" type="button" aria-label="Servidor anterior">←</button><button id="carousel-next" type="button" aria-label="Próximo servidor">→</button></div></div><div class="primary-grid carousel-metrics all-metrics">${metricSections(groups.slice(overviewMetricPage * 2, overviewMetricPage * 2 + 2), healthOf(server))}</div><p class="carousel-caption"><span>${overviewMetricPage + 1} / ${pages.length} · 26 pontos</span><span>${!server.collecting ? 'Sem dados recentes · ' : ''}${paused ? 'Atualização pausada · ' : ''}Amostra: ${sampleAge(server)}</span></p></section>`;
}
function advanceCarousel() {
  if (paused || activeServerId || !SERVERS.length || !document.getElementById('carousel-next')) return;
  overviewMetricPage = (overviewMetricPage + 1) % 3;
  if (overviewMetricPage === 0) carouselIndex = (carouselIndex + 1) % SERVERS.length;
  renderFleet();
}
function metricCards(metrics, health = {signals: []}) {
  return metrics.map(m => {
    const available = hasMetricValue(m.key, m.value);
    const text = PI_TEXT_METRICS.has(m.key);
    const reading = !available ? '—' : text ? String(m.value) : format(m.value, Number(m.digits || 0));
    const signal = health.signals.filter(signal => signal.metric === m.key).sort((a,b) => HEALTH_STATES[a.state].priority - HEALTH_STATES[b.state].priority)[0];
    const state = !available ? 'unknown' : signal?.state || 'neutral';
    const label = !available ? 'Sem dados' : state === 'unknown' ? 'Análise pendente' : signal ? HEALTH_STATES[state].label : '';
    const indicator = available && m.unit === '%' ? `<div class="metric-indicator" aria-hidden="true"><i style="width:${Math.min(100, Math.max(0, m.value))}%"></i></div>` : '';
    const marker = label ? contextIcon(state === 'unknown' ? 'unknown' : signal?.kind === 'absolute' ? 'absolute' : 'trend') : '';
    return `<article class="metric-card ${state} ${text ? 'text-metric' : ''}" data-metric="${m.key}"><div class="card-heading"><span>${escapeHtml(m.label)}</span>${label ? `<span class="metric-status">${marker}${label}</span>` : ''}</div><div class="metric-body"><strong class="metric-value" title="${escapeHtml(reading)}">${escapeHtml(reading)}<em>${available ? escapeHtml(m.unit || '') : ''}</em></strong></div>${indicator}</article>`;
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
function renderDetail(server) {
  const health = healthOf(server), groups = serverMetricGroups(visibleMetrics(server));
  const metadata = [server.site, server.environment, server.role].filter(Boolean).map(escapeHtml).join(' · ');
  const available = groups.flatMap(group => group.items).filter(item => hasMetricValue(item.key,item.value)).length;
  const pages = ['Runtime e scripts', 'Eventos', 'Servidor e coleta'];
  detailMetricPage = ((detailMetricPage % pages.length) + pages.length) % pages.length;
  const alarmPages = Math.max(1, Math.ceil(health.signals.length / 2));
  detailAlarmPage = ((detailAlarmPage % alarmPages) + alarmPages) % alarmPages;
  renderMetricPageControls(pages, detailMetricPage, true);
  main.innerHTML = `<section class="server-detail-carousel"><div class="overview"><div><a href="#overview" class="back-link">← Todos os servidores</a><h1>${escapeHtml(server.name)}<span>.</span></h1><p>${metadata}</p></div>${statusBadge(health.state)}</div>${serverAlarmPanel(server,health,2,detailAlarmPage)}<p class="metric-summary">${available} de 26 pontos com dados válidos recentes · Amostra essencial: ${sampleAge(server)} · Valores sem qualidade ou vencidos aparecem como —</p><div class="primary-grid detail-metrics all-metrics">${metricSections(groups.slice(detailMetricPage * 2, detailMetricPage * 2 + 2), health)}</div></section>`;
}
function renderRoute(moveFocus = false) {
  document.body?.classList.toggle('overview-page', !location.hash.startsWith('#server/'));
  document.body?.classList.toggle('detail-page', location.hash.startsWith('#server/'));
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
  renderRoute();
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
  const detailAlarmPageButton = event.target.closest('[data-detail-alarm-page]');
  if (detailAlarmPageButton) { detailAlarmPage = Number(detailAlarmPageButton.dataset.detailAlarmPage); renderDetail(SERVERS.find(server => server.id === activeServerId)); return; }
  const detailMetricPageButton = event.target.closest('[data-detail-metric-page]');
  if (detailMetricPageButton) { detailMetricPage = Number(detailMetricPageButton.dataset.detailMetricPage); renderDetail(SERVERS.find(server => server.id === activeServerId)); return; }
  const metricPage = event.target.closest('[data-metric-page]');
  if (metricPage) { overviewMetricPage = Number(metricPage.dataset.metricPage); renderFleet(); return; }
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
  const interacting = document.activeElement?.closest('#main a, #main button, #metric-page-controls button');
  if (paused || interacting) return;
  if (!paused && !activeServerId) {
    monitoringPage++;
    advanceCarousel();
  } else if (activeServerId) {
    detailMetricPage = (detailMetricPage + 1) % 3;
    detailAlarmPage++;
    renderDetail(SERVERS.find(server => server.id === activeServerId));
  }
}, CAROUSEL_INTERVAL_MS);
setInterval(() => {
  if (document.activeElement?.closest('#main a, #main button, #metric-page-controls button')) return;
  if (activeServerId) {
    renderDetail(SERVERS.find(server => server.id === activeServerId));
  }
  else renderFleet();
  renderConnectionState();
}, 10000);
renderClock();
setInterval(renderClock, 1000);

