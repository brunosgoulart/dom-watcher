/* Version: 1.4 | Date: 13/10/2026
Changes: Classified server health and radar signals using trend states, insufficient history and output write failures. */
'use strict';
const PI_TEXT_METRICS = new Set(['collectionTimestamp', 'fileRead', 'serverStatus']);
function hasMetricValue(key, value) { return Number.isFinite(value) || PI_TEXT_METRICS.has(key) && (typeof value === 'boolean' || typeof value === 'string' && value.trim().length > 0); }
const HEALTH_STATES = {
  healthy: { label: 'Sem alarmes ativos', priority: 3 }, warning: { label: 'Atenção', priority: 1 },
  critical: { label: 'Crítico', priority: 0 }, unknown: { label: 'Estado não confirmado', priority: 2 }
};
let HEALTH_LIMITS = { staleSeconds: 120 };
function healthOf(server, now = Date.now()) {
  const absoluteSignals = (server.absoluteAlarms || []).flatMap(alarm => {
    const valid = server.apiAvailable !== false && Number.isFinite(server.metrics?.[alarm.metric]) && Number.isFinite(alarm.timestamp) && now - alarm.timestamp >= 0 && now - alarm.timestamp <= HEALTH_LIMITS.staleSeconds * 1000;
    const state = valid ? alarm.state : 40;
    const failure = alarm.writeStatus === 'failed' ? [{ state: 'warning', title: 'Falha na publicação PI', description: 'Escrita do alarme absoluto não confirmada.' }] : [];
    if (state === 0) return failure;
    const units = { runCPU: '%', runMemory: '%', runPVT: 'KiB', runErrorsPerMinute: 'erros/min', runLocalPending: 'eventos', runRemotePending: 'eventos' };
    const names = { runCPU: 'CPU', runMemory: 'RAM', runPVT: 'memória privada', runErrorsPerMinute: 'erros', runLocalPending: 'fila local', runRemotePending: 'fila remota' };
    const signal = { metric: alarm.metric, kind: 'absolute', state: state === 20 ? 'critical' : 'unknown', stateLabel: state === 20 ? 'Limite atingido' : 'Sem dados', title: `Limite absoluto de ${names[alarm.metric]}`, description: state === 40 ? 'Limite absoluto: sem medição válida recente.' : `Limite ≥ ${alarm.limit.toLocaleString('pt-BR')} ${units[alarm.metric]}` };
    return [signal, ...failure];
  });
  const unknown = message => {
    const signals = [...absoluteSignals, { state: 'unknown', title: 'Coleta sem dados válidos', description: message }].sort((a, b) => HEALTH_STATES[a.state].priority - HEALTH_STATES[b.state].priority);
    return { state: signals[0].state, alerts: signals.map(signal => `${signal.title}: ${signal.description}`), signals };
  };
  if (!Number.isFinite(server.sampleTime) || now - server.sampleTime > HEALTH_LIMITS.staleSeconds * 1000 || server.sampleTime > now || !server.collecting) {
    return unknown('Coleta sem dados recentes. O estado operacional não pode ser confirmado.');
  }
  const m = server.metrics;
  if (['runCPU', 'runMemory', 'runErrorsPerMinute', 'runLocalPending', 'runRemotePending'].some(key => !Number.isFinite(m[key]))) return unknown('Métricas essenciais ausentes na amostra.');
  if (!Array.isArray(server.trends) || !['runCPU', 'runMemory', 'runPVT', 'runErrorsPerMinute', 'runLocalPending', 'runRemotePending'].every(key => server.trends.some(t => t.metric === key))) return unknown('Motor de tendências ainda indisponível.');
  const titles = { runCPU: 'Tendência de CPU', runMemory: 'Tendência de RAM', runPVT: 'Tendência de memória privada', runErrorsPerMinute: 'Tendência de erros', runLocalPending: 'Tendência da fila local', runRemotePending: 'Tendência da fila remota' };
  const signals = server.trends.filter(t => t.state !== 0 && (t.state >= 30 || !Number.isFinite(t.slope) || t.slope > 0)).map(t => ({
    metric: t.metric,
    state: t.state === 20 ? 'critical' : t.state === 10 ? 'warning' : 'unknown',
    stateLabel: t.state === 30 ? 'Histórico' : t.state === 40 ? 'Sem dados' : t.stateLabel,
    title: t.metric === 'runTRD' ? 'Threads' : titles[t.metric],
    description: t.state >= 30 ? t.reason : `${Number.isFinite(t.slope) ? (t.metric === 'runPVT' ? t.slope / 1024 : t.slope).toLocaleString('pt-BR', ['runCPU', 'runMemory'].includes(t.metric) ? { minimumFractionDigits: 1, maximumFractionDigits: 2 } : { maximumFractionDigits: 2 }) : '—'} ${t.metric === 'runPVT' ? 'MiB/min' : ['runCPU', 'runMemory'].includes(t.metric) ? 'p.p./min' : t.metric === 'runErrorsPerMinute' ? 'erros/min²' : 'eventos/min'} · score ${Number.isFinite(t.score) ? t.score.toFixed(2) : '—'} · janela ${t.windowSeconds / 60} min · publicação ${t.writeStatus}`
  }));
  if (server.trends.some(t => t.writeStatus === 'failed')) signals.push({ state: 'warning', title: 'Falha na publicação PI', description: 'Alarme calculado, mas escrita da tag de saída não confirmada.' });
  signals.push(...absoluteSignals);
  for (const signal of signals) {
    if (signal.metric === 'runTRD') signal.description = signal.description.replace('eventos/min', 'threads/min');
    if (['runCPU', 'runMemory'].includes(signal.metric)) {
      signal.description = signal.description.replace(/^(.+?) p\.p\.\/min/, '↑ $1 por minuto');
    }
  }
  signals.sort((a, b) => HEALTH_STATES[a.state].priority - HEALTH_STATES[b.state].priority);
  return { state: signals[0]?.state || 'healthy', alerts: signals.map(signal => `${signal.title}: ${signal.description}`), signals };
}
const MAX_MONITORED_SERVERS = 7;
const SCADA_SERVER_POSITIONS = [];
const SERVERS = [];
for (let position = 1; position <= MAX_MONITORED_SERVERS; position++) {
  const id = `slot-${position}`;
  SCADA_SERVER_POSITIONS.push(id);
  SERVERS.push({ id, name: `Servidor ${position}`, site: 'Não configurado', environment: '', role: '', collecting: false, sampleTime: null, metrics: {}, histories: { local: [], remote: [] }, message: 'Aguardando API PI.' });
}
