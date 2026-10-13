/* Version: 1.4 | Date: 13/10/2026
Changes: Classified server health and radar signals using trend states, insufficient history and output write failures. */
'use strict';
const HEALTH_STATES = {
  healthy: { label: 'Saudável', priority: 3 }, warning: { label: 'Atenção', priority: 1 },
  critical: { label: 'Crítico', priority: 0 }, unknown: { label: 'Sem dados recentes', priority: 2 }
};
let HEALTH_LIMITS = { staleSeconds: 120, cpuWarning: 75, cpuCritical: 90, memoryWarning: 80, memoryCritical: 90, privateWarningKB: 700 * 1024, privateCriticalKB: 900 * 1024, errorsCritical: 5, pendingWarning: 1000 };
function healthOf(server, now = Date.now()) {
  const unknown = message => ({ state: 'unknown', alerts: [message], signals: [{ state: 'unknown', title: 'Coleta sem dados válidos', description: message }] });
  if (!Number.isFinite(server.sampleTime) || now - server.sampleTime > HEALTH_LIMITS.staleSeconds * 1000 || server.sampleTime > now || !server.collecting) {
    return unknown('Coleta sem dados recentes. O estado operacional não pode ser confirmado.');
  }
  const m = server.metrics;
  if (['runCPU', 'runMemory', 'runErrorsPerMinute', 'runLocalPending', 'runRemotePending'].some(key => !Number.isFinite(m[key]))) return unknown('Métricas essenciais ausentes na amostra.');
  if (!Array.isArray(server.trends) || server.trends.length !== 6) return unknown('Motor de tendências ainda indisponível.');
  const titles = { runCPU: 'Tendência de CPU', runMemory: 'Tendência de RAM', runPVT: 'Tendência de memória privada', runErrorsPerMinute: 'Tendência de erros', runLocalPending: 'Tendência da fila local', runRemotePending: 'Tendência da fila remota' };
  const signals = server.trends.filter(t => t.state !== 0).map(t => ({
    state: t.state === 20 ? 'critical' : t.state === 10 ? 'warning' : 'unknown',
    stateLabel: t.state === 30 ? 'Histórico' : t.state === 40 ? 'Sem dados' : t.stateLabel,
    title: titles[t.metric],
    description: t.state >= 30 ? t.reason : `${Number.isFinite(t.slope) ? (t.metric === 'runPVT' ? t.slope / 1024 : t.slope).toLocaleString('pt-BR', { maximumFractionDigits: 2 }) : '—'} ${t.metric === 'runPVT' ? 'MiB/min' : ['runCPU', 'runMemory'].includes(t.metric) ? 'p.p./min' : t.metric === 'runErrorsPerMinute' ? 'erros/min²' : 'eventos/min'} · score ${Number.isFinite(t.score) ? t.score.toFixed(2) : '—'} · janela ${t.windowSeconds / 60} min · publicação ${t.writeStatus}`
  }));
  if (server.trends.some(t => t.writeStatus === 'failed')) signals.push({ state: 'warning', title: 'Falha na publicação PI', description: 'Alarme calculado, mas escrita da tag de saída não confirmada.' });
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
