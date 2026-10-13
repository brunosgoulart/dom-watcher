/* Version: 1.16 | Date: 13/10/2026
Changes: Explained full-duration sustained-rise triggering, optional historical severity and recovery confirmation. */
'use strict';
const format = (value, digits = 0) => Number.isFinite(value) ? new Intl.NumberFormat('pt-BR', { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(value) : '—';
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const main = document.getElementById('main');
const fleetFilters = { search: '', status: 'all', environment: 'all', sort: 'priority', page: 1 };
const PAGE_SIZE = 6;
let paused = false;
let historyMinutes = 15;
let activeServerId = null;
let radarPage = 0;
const RADAR_PAGE_SIZE = 6;
const statusBadge = state => `<span class="health-badge ${state}"><i></i>${HEALTH_STATES[state].label}</span>`;
function sampleAge(server) {
  if (!Number.isFinite(server.sampleTime)) return '—';
  const seconds = Math.max(0, Math.floor((Date.now() - server.sampleTime) / 1000));
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min`;
}
function visibleMetrics(server) { return healthOf(server).state === 'unknown' ? {} : server.metrics; }
function filteredServers() {
  const query = fleetFilters.search.toLocaleLowerCase('pt-BR').trim();
  return SERVERS.filter(s => `${s.name} ${s.site} ${s.role}`.toLocaleLowerCase('pt-BR').includes(query) &&
    (fleetFilters.status === 'all' || healthOf(s).state === fleetFilters.status) &&
    (fleetFilters.environment === 'all' || s.environment === fleetFilters.environment)).sort((a, b) => {
    if (fleetFilters.sort === 'name') return a.name.localeCompare(b.name);
    if (fleetFilters.sort === 'cpu') return (visibleMetrics(b).runCPU ?? -1) - (visibleMetrics(a).runCPU ?? -1) || a.name.localeCompare(b.name);
    return HEALTH_STATES[healthOf(a).state].priority - HEALTH_STATES[healthOf(b).state].priority || a.name.localeCompare(b.name);
  });
}
function loadState(value, warning, critical) {
  return !Number.isFinite(value) ? 'unknown' : value >= critical ? 'critical' : value >= warning ? 'warning' : 'healthy';
}
function renderExecutive() {
  const signals = SERVERS.flatMap(server => healthOf(server).signals.map(signal => ({ ...signal, server })))
    .sort((a, b) => HEALTH_STATES[a.state].priority - HEALTH_STATES[b.state].priority || a.server.name.localeCompare(b.server.name));
  const operationalCount = signals.filter(signal => signal.state !== 'unknown').length;
  const collectionCount = signals.length - operationalCount;
  const visuals = {
    'Tendência de CPU': ['CPU · tendência', '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 1v5m6-5v5M9 18v5m6-5v5M1 9h5m-5 6h5m12-6h5m-5 6h5"/><rect x="9" y="9" width="6" height="6"/>'],
    'Tendência de RAM': ['RAM · tendência', '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10v4m5-4v4m5-4v4M7 18v3m5-3v3m5-3v3"/>'],
    'Tendência de memória privada': ['Memória privada · tendência', '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 9h10M7 13h5"/><rect x="14" y="12" width="4" height="4"/>'],
    'Tendência de erros': ['Erros · tendência', '<path d="m8 5-6 7 6 7m8-14 6 7-6 7m-3-10-2 6"/>'],
    'Tendência da fila local': ['Fila local', '<rect x="3" y="3" width="18" height="5" rx="1"/><rect x="3" y="10" width="18" height="5" rx="1"/><rect x="3" y="17" width="18" height="4" rx="1"/>'],
    'Tendência da fila remota': ['Fila remota', '<rect x="3" y="3" width="18" height="5" rx="1"/><rect x="3" y="10" width="18" height="5" rx="1"/><rect x="3" y="17" width="18" height="4" rx="1"/>'],
    'Coleta sem dados válidos': ['Coleta', '<path d="M3 12h4l3-7 4 14 3-7h4M3 3l18 18"/>']
  };
  const radarPages = Math.max(1, Math.ceil(signals.length / RADAR_PAGE_SIZE));
  radarPage %= radarPages;
  const signalRows = signals.slice(radarPage * RADAR_PAGE_SIZE, (radarPage + 1) * RADAR_PAGE_SIZE).map(signal => {
    const [label, icon] = visuals[signal.title] || [signal.title, '<circle cx="12" cy="12" r="9"/><path d="M12 7v6m0 3v1"/>'];
    const value = signal.state === 'unknown' ? '—' : signal.description.split(' · ')[0].replace('eventos Local + Remote', 'eventos');
    return `<a class="signal-tile ${signal.state}" href="#server/${encodeURIComponent(signal.server.id)}" title="${escapeHtml(signal.description)}" aria-label="${escapeHtml(signal.title)} no servidor ${escapeHtml(signal.server.name)}: ${HEALTH_STATES[signal.state].label}. ${escapeHtml(signal.description)}"><div class="signal-tile-top"><svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg><span class="signal-state">${signal.stateLabel || (signal.state === 'unknown' ? 'Sem dados' : HEALTH_STATES[signal.state].label)}</span></div><strong class="signal-value">${escapeHtml(value)}</strong><span class="signal-metric">${escapeHtml(label)}</span><span class="signal-server">${escapeHtml(signal.server.name)} <b>↗</b></span></a>`;
  }).join('');
  const signalPanel = `<article class="executive-panel signals-panel"><h2>RADAR OPERACIONAL</h2><div class="signal-summary"><span class="critical">● ${signals.filter(signal => signal.state === 'critical').length} críticos</span><span class="warning">● ${operationalCount - signals.filter(signal => signal.state === 'critical').length} atenção</span><span class="unknown">● ${collectionCount} sem dados</span></div><div class="signal-list" aria-label="Indicadores visuais por servidor, ordenados por gravidade">${signalRows || '<div class="signals-empty healthy">✓ Nenhuma tendência anormal confirmada</div>'}</div><p class="signal-footnote">Página ${radarPage + 1} de ${radarPages}</p></article>`;
  const loadRows = SCADA_SERVER_POSITIONS.map(id => SERVERS.find(server => server.id === id)).map((server, position) => {
    const s = server || { id: SCADA_SERVER_POSITIONS[position], name: `Servidor ${position + 1}`, collecting: false, sampleTime: null, metrics: {} };
    const m = visibleMetrics(s);
    const bars = [
      ['CPU', m.runCPU, HEALTH_LIMITS.cpuWarning, HEALTH_LIMITS.cpuCritical],
      ['RAM', m.runMemory, HEALTH_LIMITS.memoryWarning, HEALTH_LIMITS.memoryCritical]
    ].map(([label, value, warning, critical]) => {
      const state = loadState(value, warning, critical);
      const stateLabel = state === 'healthy' ? 'OK' : state === 'unknown' ? 'Sem dados' : HEALTH_STATES[state].label;
      const display = Number.isFinite(value) ? `${format(value, 1)}%` : '—';
      return `<div class="load-metric ${state}"><span class="load-metric-name">${label}</span><div class="load-track" aria-hidden="true"><i style="width:${Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0}%"></i><b style="left:${warning}%"></b><b style="left:${critical}%"></b></div><small>${display} <span>${stateLabel}</span></small></div>`;
    }).join('');
    return `<a class="load-row" href="#server/${s.id}"><span>${escapeHtml(s.name)}</span><div class="load-metrics">${bars}</div></a>`;
  }).join('');
  document.getElementById('executive-panels').innerHTML = `<article class="executive-panel"><h2>Desempenho do Ambiente SCADA <span>AMOSTRA ATUAL</span></h2>${loadRows}<div class="load-thresholds"><strong>Limites demonstrativos</strong><span>CPU E3Run: OK &lt; ${HEALTH_LIMITS.cpuWarning}% · atenção ≥ ${HEALTH_LIMITS.cpuWarning}% · crítico ≥ ${HEALTH_LIMITS.cpuCritical}%</span><span>Memória do sistema: OK &lt; ${HEALTH_LIMITS.memoryWarning}% · atenção ≥ ${HEALTH_LIMITS.memoryWarning}% · crítico ≥ ${HEALTH_LIMITS.memoryCritical}%</span><span>Sem dados: coleta ausente ou amostra sem validade. Não significa OK.</span></div></article>${signalPanel}`;
}
function renderFleetRows() {
  renderExecutive();
  const filtered = filteredServers(), pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  fleetFilters.page = Math.max(1, Math.min(fleetFilters.page, pages));
  const offset = (fleetFilters.page - 1) * PAGE_SIZE;
  document.getElementById('fleet-rows').innerHTML = filtered.slice(offset, offset + PAGE_SIZE).map(server => {
    const health = healthOf(server), m = visibleMetrics(server);
    return `<tr><td><a class="server-name" href="#server/${encodeURIComponent(server.id)}">${escapeHtml(server.name)} <span>↗</span></a><small>${escapeHtml(server.role)}</small></td><td>${escapeHtml(server.site)}<small>${escapeHtml(server.environment)}</small></td><td>${statusBadge(health.state)}</td><td class="numeric">${format(m.runCPU, 1)}${Number.isFinite(m.runCPU) ? '%' : ''}</td><td class="numeric">${format(m.runMemory, 1)}${Number.isFinite(m.runMemory) ? '%' : ''}</td><td class="numeric">${format(Number.isFinite(m.runLocalPending) && Number.isFinite(m.runRemotePending) ? m.runLocalPending + m.runRemotePending : null)}</td><td class="numeric">${format(m.runErrorsPerMinute)}</td><td>${sampleAge(server)}<small>${health.state === 'unknown' ? 'Coleta desatualizada' : 'Última amostra PI'}</small></td><td><a class="detail-link" href="#server/${encodeURIComponent(server.id)}" aria-label="Abrir detalhes de ${escapeHtml(server.name)}">Detalhes →</a></td></tr>`;
  }).join('') || '<tr><td colspan="9" class="empty-state">Nenhum servidor encontrado. Ajuste a busca ou os filtros.</td></tr>';
  document.getElementById('result-count').textContent = `${filtered.length ? offset + 1 : 0}–${Math.min(offset + PAGE_SIZE, filtered.length)} de ${filtered.length} servidores`;
  document.getElementById('page-count').textContent = `Página ${fleetFilters.page} de ${pages}`;
  document.getElementById('previous-page').disabled = fleetFilters.page === 1;
  document.getElementById('next-page').disabled = fleetFilters.page >= pages;
}
function renderFleet() {
  main.innerHTML = `<div class="overview"><div><h1>Visão Geral</h1></div><span class="inventory-label">${SERVERS.length} SERVIDORES / ${new Set(SERVERS.map(s => s.site)).size} UNIDADES</span></div><section class="executive-panels" id="executive-panels" aria-label="KPIs de todo o inventário, independentes dos filtros"></section><section class="fleet-panel" aria-labelledby="inventory-title"><div class="fleet-panel-header"><div><h2 id="inventory-title">SERVIDORES MONITORADOS</h2><p>Prioridade para os servidores que precisam de atenção.</p></div><button type="button" id="clear-filters">Limpar filtros</button></div><div class="fleet-toolbar"><label class="search-label">Buscar servidor<input id="server-search" type="search" placeholder="Nome, unidade ou aplicação" value="${escapeHtml(fleetFilters.search)}"></label><label>Saúde<select id="health-filter"><option value="all">Todos os estados</option>${Object.entries(HEALTH_STATES).map(([key, state]) => `<option value="${key}" ${fleetFilters.status === key ? 'selected' : ''}>${state.label}</option>`).join('')}</select></label><label>Ambiente<select id="environment-filter"><option value="all">Todos os ambientes</option>${[...new Set(SERVERS.map(s => s.environment))].map(value => `<option ${fleetFilters.environment === value ? 'selected' : ''}>${escapeHtml(value)}</option>`).join('')}</select></label><label>Ordenar por<select id="sort-filter"><option value="priority">Prioridade de saúde</option><option value="name">Nome do servidor</option><option value="cpu">Maior CPU do E3Run</option></select></label></div><div class="table-scroll"><table><caption class="sr-only">Servidores monitorados com métricas do PI por servidor</caption><thead><tr><th scope="col">Servidor</th><th scope="col">Unidade / ambiente</th><th scope="col">Saúde</th><th scope="col">CPU E3Run</th><th scope="col">Memória</th><th scope="col">Pendentes</th><th scope="col">Erros/min</th><th scope="col">Idade da amostra</th><th scope="col">Ação</th></tr></thead><tbody id="fleet-rows"></tbody></table></div><div class="pagination"><span id="result-count" aria-live="polite"></span><div><button id="previous-page" type="button" aria-label="Página anterior">←</button><span id="page-count"></span><button id="next-page" type="button" aria-label="Próxima página">→</button></div></div></section><details class="health-rules"><summary>Como os alarmes de tendência são calculados?</summary><p>Disparo ao completar ${PI_DATA_STATE.policy.windowSeconds / 60} minutos de elevação sustentada, inclusive habitual, sem confirmações adicionais. Pequenas oscilações são permitidas, mas todos os trechos móveis de até ${PI_DATA_STATE.policy.continuitySeconds / 60} minutos devem manter alta. A referência anterior de ${PI_DATA_STATE.policy.referenceSeconds / 60} minutos e a janela complementar de memória de ${PI_DATA_STATE.policy.memoryWindowSeconds / 60} minutos servem apenas para classificar a gravidade, sem bloquear o disparo. Recuperação exige ${PI_DATA_STATE.policy.recoverySamples} medições novas. Intervalo de medição: ${PI_DATA_STATE.policy.measurementSeconds} s. Estados: 0 normal, 10 atenção, 20 crítico, 30 histórico insuficiente e 40 dados inválidos. A escrita no PI é uma etapa independente; seus erros ficam visíveis. As cores das barras de carga continuam apenas como referência absoluta, não geram as tags de alarme.</p></details>`;
  document.getElementById('sort-filter').value = fleetFilters.sort;
  renderFleetRows();
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
function renderFlows(server) {
  document.getElementById('flows').innerHTML = ['local', 'remote'].map(kind => {
    const history = server.histories[kind], end = history.at(-1)?.timestamp;
    const samples = history.filter(item => item.timestamp >= end - historyMinutes * 60000);
    const latest = healthOf(server).state !== 'unknown' ? samples.at(-1) : null;
    return `<div><div class="flow-metrics"><div class="flow-stat"><small>Enfileirados</small><b>${format(latest?.entered)} <span>/min</span></b></div><div class="flow-stat"><small>Tratados</small><b>${format(latest?.handled)} <span>/min</span></b></div><div class="flow-stat"><small>Descarte</small><b>${format(latest?.discard, 1)} <span>%</span></b></div></div><article class="chart-card"><div class="chart-header"><h3>EVENTOS ${kind.toUpperCase()}</h3><span>eventos / minuto · PI</span></div>${chartSvg(kind, samples)}<div class="legend"><span><i></i>Enfileirados</span><span><i></i>Tratados</span></div></article></div>`;
  }).join('');
}
function uptime(minutes) { return Number.isFinite(minutes) ? `${Math.floor(minutes / 1440)} d ${Math.floor(minutes % 1440 / 60)} h ${minutes % 60} min` : '—'; }
function renderDetail(server) {
  const health = healthOf(server), m = visibleMetrics(server), valid = health.state !== 'unknown';
  const performance = [
    { label: 'CPU · E3RUN', value: m.runCPU, unit: '%', digits: 1, icon: '▣', detail: 'Carga do processo', progress: true },
    { label: 'MEMÓRIA · SISTEMA', value: m.runMemory, unit: '%', digits: 1, icon: '▥', detail: 'MemoryLoad publicado no PI', progress: true },
    { label: 'MEMÓRIA PRIVADA', value: m.runPVT, unit: 'KB', icon: '▤', detail: 'PVT do E3Run' },
    { label: 'THREADS · E3RUN', value: m.runTRD, icon: '⌘', detail: 'Threads em execução' }
  ];
  const events = [
    { label: 'PENDENTES · LOCAL', value: m.runLocalPending, icon: '≋', detail: 'Eventos na fila local' },
    { label: 'PENDENTES · REMOTE', value: m.runRemotePending, icon: '≋', detail: 'Eventos na fila remota' },
    { label: 'OCUPAÇÃO · SCRIPTS', value: m.runOccupancy, unit: '%', digits: 1, icon: '⚙', detail: 'Ocupação do E3Run', progress: true },
    { label: 'ERROS · SCRIPTS', value: m.runErrorsPerMinute, unit: '/min', icon: '◇', detail: 'Taxa publicada no PI' }
  ];
  main.innerHTML = `<div class="overview"><div><a href="#overview" class="back-link">← Todos os servidores</a><h1>${escapeHtml(server.name)}<span>.</span></h1><p>${escapeHtml(server.site)} <span class="metadata-separator">/</span> ${escapeHtml(server.environment)} <span class="metadata-separator">/</span> ${escapeHtml(server.role)}</p></div>${statusBadge(health.state)}</div><section class="server-alerts ${health.state}" aria-label="Diagnóstico do servidor"><strong>${health.alerts.length ? `${health.alerts.length} ${health.alerts.length === 1 ? 'sinalização' : 'sinalizações'} neste servidor` : 'Nenhuma tendência anormal confirmada'}</strong>${health.alerts.length ? `<ul>${health.alerts.map(alert => `<li>${escapeHtml(alert)}</li>`).join('')}</ul>` : '<p>Métricas com histórico suficiente e sem tendência anormal confirmada.</p>'}</section><div class="primary-grid"><section aria-labelledby="performance-title"><h2 id="performance-title">PERFORMANCE <span>E3RUN</span></h2><div class="metric-grid">${metricCards(performance)}</div></section><section aria-labelledby="events-title"><h2 id="events-title">EVENTOS <span>LOCAL / REMOTE</span></h2><div class="metric-grid">${metricCards(events)}</div></section><section aria-labelledby="process-title"><h2 id="process-title">PROCESSOS <span>STATUS</span></h2><div class="status-stack">${['E3RUN', 'E3SERVER'].map(process => `<article class="status-card"><div class="card-heading">${process} <span class="status-dot ${valid ? '' : 'unknown'}"></span></div><div class="process-info"><span class="process-icon">▣</span><span>${process === 'E3RUN' ? 'Runtime' : 'Servidor'}<small>${process === 'E3RUN' ? 'Processo de execução' : valid ? `CPU ${format(m.serverCPU, 1)}% · ${format(m.serverHDL)} handles` : 'Sem dados recentes'}</small></span></div><div class="status-banner ${valid ? '' : 'unknown'}">${valid ? 'MÉTRICAS DISPONÍVEIS NO PI' : 'ESTADO NÃO CONFIRMADO'}</div>${process === 'E3RUN' ? `<div class="status-bottom">Uptime <b>${uptime(m.runUptimeMinutes)}</b></div>` : ''}</article>`).join('')}</div></section><section aria-labelledby="quality-title"><h2 id="quality-title">COLETA <span>QUALIDADE</span></h2><div class="quality-card"><div class="card-heading">FONTE PI <span class="outline-label">SDK COM</span></div><span class="quality-icon ${valid ? 'healthy' : 'unknown'}">${valid ? '✓' : '?'}</span><strong class="${health.state}">${valid ? 'AMOSTRA DISPONÍVEL' : 'SEM DADOS RECENTES'}</strong><p>${valid ? 'Valores válidos publicados no PI' : 'Valores atuais não disponíveis'}</p><div class="quality-checks">${[['CPU', m.runCPU], ['RAM', m.runMemory], ['Erros', m.runErrorsPerMinute], ['Fila de E/S', m.ioQueuePending]].map(([label, value]) => `<span>${label} <b>${Number.isFinite(value) ? '✓' : '—'}</b></span>`).join('')}</div><dl><div><dt>Idade da amostra</dt><dd>${sampleAge(server)}</dd></div><div><dt>Tempo de leitura</dt><dd>${format(m.totalTime, 3)}${valid ? ' s' : ''}</dd></div><div><dt>Reset de contadores</dt><dd>—</dd></div></dl></div></section></div><section class="flow-section" aria-labelledby="flow-title"><div class="section-bar"><h2 id="flow-title">FLUXO DE EVENTOS · ${escapeHtml(server.name)}</h2><label>Janela do histórico <select id="window"><option value="15">Últimos 15 minutos</option><option value="30">Últimos 30 minutos</option><option value="60">Última hora</option></select></label></div><div class="flow-grid" id="flows"></div></section><section class="bottom-grid" aria-label="Recursos e informações da coleta"><article class="resource"><span class="resource-icon">▤</span><div><small>ESPAÇO LIVRE · C:</small><strong>${format(m.driveCFreeMB)} <em>${valid ? 'MB' : ''}</em></strong></div></article><article class="resource"><span class="resource-icon">⌁</span><div><small>FILA DE E/S</small><strong>${format(m.ioQueuePending)} <em>${valid ? 'pendentes' : ''}</em></strong></div><span class="resource-note">Atraso médio: ${format(m.ioQueueAvgDelay, 1)}</span></article><article class="resource"><span class="resource-icon">▧</span><div><small>ARQUIVO ETL</small><strong>${format(m.etlFileSizeMB, 1)} <em>${valid ? 'MB' : ''}</em></strong></div><span class="resource-note">Tamanho publicado no PI</span></article></section>`;
  document.getElementById('window').value = historyMinutes;
  renderFlows(server);
}
function renderRoute(moveFocus = false) {
  const hash = location.hash.slice(1);
  let id = null;
  try { if (hash.startsWith('server/')) id = decodeURIComponent(hash.slice(7)); } catch { id = '__invalid__'; }
  const server = SERVERS.find(item => item.id === id);
  activeServerId = server?.id || null;
  document.getElementById('server-select').value = activeServerId || '';
  document.getElementById('fleet-link').setAttribute('aria-current', !id ? 'page' : 'false');
  if (id && !server) {
    main.innerHTML = '<div class="empty-state"><h1>Servidor não encontrado</h1><p>Este identificador não pertence ao inventário de demonstração.</p><a class="back-link" href="#overview">← Voltar à visão geral</a></div>';
    document.title = 'E3 Monitor — Servidor não encontrado';
  } else if (server) { renderDetail(server); document.title = `E3 Monitor — ${server.name}`; }
  else { renderFleet(); document.title = 'E3 Monitor — Visão geral'; }
  if (moveFocus) { main.focus({ preventScroll: true }); window.scrollTo(0, 0); }
}
function renderConnectionState() {
  const state = PI_DATA_STATE;
  document.getElementById('source-badge').textContent = state.status === 'connected' ? 'PI SDK · CONECTADO' : state.status === 'not-configured' ? 'PI · NÃO CONFIGURADO' : state.status === 'degraded' ? 'PI · DADOS PARCIAIS' : 'PI · SEM CONEXÃO';
  document.getElementById('simulation-status').textContent = paused ? 'Atualização pausada' : state.message;
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
main.addEventListener('input', event => {
  if (event.target.id === 'server-search') { fleetFilters.search = event.target.value; fleetFilters.page = 1; renderFleetRows(); }
});
main.addEventListener('change', event => {
  const key = { 'health-filter': 'status', 'environment-filter': 'environment', 'sort-filter': 'sort' }[event.target.id];
  if (key) { fleetFilters[key] = event.target.value; fleetFilters.page = 1; renderFleetRows(); }
  if (event.target.id === 'window') { historyMinutes = Number(event.target.value); renderFlows(SERVERS.find(s => s.id === activeServerId)); }
});
main.addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.id === 'clear-filters') {
    Object.assign(fleetFilters, { search: '', status: 'all', environment: 'all', sort: 'priority', page: 1 });
    renderFleet(); document.getElementById('server-search').focus();
  } else if (['previous-page', 'next-page'].includes(button.id)) {
    fleetFilters.page += button.id === 'next-page' ? 1 : -1; renderFleetRows();
  }
});
window.addEventListener('hashchange', () => renderRoute(true));
renderRoute(); renderConnectionState();
startDataSource(renderDataUpdate, () => paused);
setInterval(() => {
  if (paused || activeServerId || !document.getElementById('executive-panels') || document.activeElement?.closest('#executive-panels')) return;
  radarPage++;
  renderExecutive();
}, 10000);
setInterval(() => {
  if (document.activeElement?.closest('#main')) return;
  if (activeServerId) renderDetail(SERVERS.find(server => server.id === activeServerId));
  else if (document.getElementById('fleet-rows')) renderFleetRows();
  renderConnectionState();
}, 10000);
