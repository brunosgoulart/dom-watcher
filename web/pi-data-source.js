/* Version: 1.6 | Date: 16/10/2026
Changes: Accepted the explicit local simulation API source and its no-PI status message. */
'use strict';
const PI_DATA_STATE = { status: 'starting', message: 'Aguardando API PI', lastSuccess: null, policy: { triggerMode: 'sustained-rise', continuitySeconds: 180, measurementSeconds: 60, windowSeconds: 600, referenceSeconds: 1800, memoryWindowSeconds: 900, recoverySamples: 3 } };
const PI_ESSENTIAL = ['runCPU', 'runMemory', 'runErrorsPerMinute', 'runLocalPending', 'runRemotePending'];
function validTimestamp(value) { return Number.isFinite(value) && value > 0 && value <= Date.now(); }
function normalizeStatus(payload) {
  if (payload?.schemaVersion !== 1 || !['pi-sdk-com', 'af-sdk', 'simulated'].includes(payload.source) || !Array.isArray(payload.servers) || !payload.servers.length || payload.servers.length > MAX_MONITORED_SERVERS) throw Error('Resposta da API incompatível');
  const stale = payload.staleSeconds;
  if (!Number.isFinite(stale) || stale < 5 || stale > 86400) throw Error('Validade da amostra inválida');
  const policy = payload.trendPolicy || PI_DATA_STATE.policy;
  for (const [key, minimum, maximum] of [['windowSeconds', 120, 3600], ['referenceSeconds', 600, 7200], ['memoryWindowSeconds', 120, 3600]]) {
    if (!Number.isInteger(policy[key]) || policy[key] < minimum || policy[key] > maximum || policy[key] % 60) throw Error('Janela de tendência inválida');
  }
  if (policy.triggerMode !== 'sustained-rise' || policy.continuitySeconds !== 180 || policy.measurementSeconds !== 60 || policy.memoryWindowSeconds < policy.windowSeconds || !Number.isInteger(policy.recoverySamples) || policy.recoverySamples < 2 || policy.recoverySamples > 10) throw Error('Política de tendência inválida');
  const ids = new Set();
  const servers = payload.servers.map(server => {
    if (typeof server.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(server.id) || ids.has(server.id)) throw Error('Inventário inválido');
    ids.add(server.id);
    const metrics = {};
    for (const [key, value] of Object.entries(server.metrics || {})) {
      const quality = server.metricQuality?.[key];
      metrics[key] = Number.isFinite(value) && value >= 0 && quality?.good === true && validTimestamp(quality.timestamp) && Date.now() - quality.timestamp <= stale * 1000 ? value : null;
      if (['runCPU', 'runMemory', 'runOccupancy', 'serverCPU'].includes(key) && value > 100) metrics[key] = null;
    }
    const collecting = server.collecting === true && PI_ESSENTIAL.every(key => Number.isFinite(metrics[key])) && validTimestamp(server.sampleTime) && Date.now() - server.sampleTime <= stale * 1000;
    const trendKeys = ['runCPU', 'runMemory', 'runPVT', 'runErrorsPerMinute', 'runLocalPending', 'runRemotePending'];
    const requiredTrends = [...trendKeys];
    if (payload.source === 'simulated') trendKeys.push('runTRD');
    const trends = Array.isArray(server.trends) ? server.trends : [];
    const trendIds = new Set();
    for (const trend of trends) {
      if (!trendKeys.includes(trend.metric) || trendIds.has(trend.metric) || ![0, 10, 20, 30, 40].includes(trend.state)) throw Error('Estados de tendência inválidos');
      trendIds.add(trend.metric);
    }
    if (trends.length && !requiredTrends.every(key => trendIds.has(key))) throw Error('Tendências incompletas');
    const histories = {};
    for (const kind of ['local', 'remote']) histories[kind] = (Array.isArray(server.histories?.[kind]) ? server.histories[kind] : []).filter(point => validTimestamp(point.timestamp) && ['entered', 'handled', 'discard'].every(key => Number.isFinite(point[key]) && point[key] >= 0) && point.discard <= 100).sort((a, b) => a.timestamp - b.timestamp).slice(-120);
    return { id: server.id, name: String(server.name || server.id), site: String(server.site || ''), environment: String(server.environment || ''), role: String(server.role || ''), sampleTime: validTimestamp(server.sampleTime) ? server.sampleTime : null, collecting, metrics, histories, trends, message: String(server.message || '') };
  });
  return { servers, stale, policy };
}
function startDataSource(onUpdate, isPaused) {
  async function poll() {
    if (!isPaused()) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), PI_API_CONFIG.timeoutMs);
      try {
        const response = await fetch(PI_API_CONFIG.statusUrl, { method: 'GET', credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw Error(`API HTTP ${response.status}`);
        const payload = await response.json();
        const normalized = normalizeStatus(payload);
        SERVERS.splice(0, SERVERS.length, ...normalized.servers);
        SCADA_SERVER_POSITIONS.splice(0, SCADA_SERVER_POSITIONS.length, ...normalized.servers.map(server => server.id));
        HEALTH_LIMITS.staleSeconds = normalized.stale;
        PI_DATA_STATE.policy = normalized.policy;
        PI_DATA_STATE.source = payload.source;
        PI_DATA_STATE.status = payload.serviceStatus;
        PI_DATA_STATE.message = payload.source === 'simulated' && payload.serviceStatus === 'connected'
          ? 'Dados simulados locais ativos — sem comunicação PI'
          : ({ connected: 'Leitura PI ativa', 'not-configured': 'Configure o servidor PI e as tags', degraded: 'Leitura PI parcial', unavailable: 'Conexão PI indisponível', starting: 'Aguardando leitura PI' })[payload.serviceStatus] || 'Estado PI desconhecido';
        PI_DATA_STATE.lastSuccess = Date.now();
      } catch {
        for (const server of SERVERS) { server.collecting = false; server.message = 'API PI indisponível'; }
        PI_DATA_STATE.status = 'unavailable';
        PI_DATA_STATE.message = 'API PI indisponível — sem dados atuais';
      } finally { clearTimeout(timeout); }
      onUpdate();
    }
    setTimeout(poll, PI_API_CONFIG.refreshMs);
  }
  poll();
}

