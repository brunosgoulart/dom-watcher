'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function monitoring(reducedMotion = false) {
  const elements = new Map();
  const intervals = [];
  const document = {
    activeElement: null,
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, { innerHTML: '', value: '', addEventListener() {}, setAttribute() {} });
      return elements.get(id);
    }
  };
  const context = vm.createContext({ document, location: { hash: '#overview' }, window: { addEventListener() {}, matchMedia() { return { matches: reducedMotion }; } },
    console, setInterval: (callback, milliseconds) => intervals.push({ callback, milliseconds }),
    startDataSource() {}, PI_DATA_STATE: { policy: { windowSeconds: 600, referenceSeconds: 1800, memoryWindowSeconds: 900, recoverySamples: 3, measurementSeconds: 60, continuitySeconds: 180 } }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'servers.js'), 'utf8'), context);
  vm.runInContext(`
    SERVERS.splice(0, SERVERS.length, ...['COGCGPRO12', 'COGCGPRO34', 'COGCGPRO56'].map(id => ({
      id, name: id, site: 'Teste', environment: 'Teste', role: '', collecting: true, sampleTime: Date.now(),
      metrics: Object.fromEntries(['runCPU','runMemory','runPVT','runErrorsPerMinute','runLocalPending','runRemotePending'].map(key => [key, 10])),
      trends: ['runCPU','runMemory','runPVT','runErrorsPerMinute','runLocalPending','runRemotePending'].map(metric => ({ metric, state: 10, slope: 1, score: 2, windowSeconds: 600 }))
    })));
    SCADA_SERVER_POSITIONS.splice(0, SCADA_SERVER_POSITIONS.length, ...SERVERS.map(s => s.id));
  `, context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'app.js'), 'utf8'), context);
  return { context, intervals, html: () => elements.get('main').innerHTML };
}

test('connection statuses are inside an accessible information disclosure and clock stays outside', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'index.html'), 'utf8');
  const disclosure = html.match(/<details class="connection-details"[\s\S]*?<\/details>/)?.[0];
  assert.ok(disclosure);
  assert.match(disclosure, /summary aria-label="Informações da conexão"/);
  assert.match(disclosure, /id="connection-status"/);
  assert.match(disclosure, /id="updated"/);
  assert.doesNotMatch(disclosure, /id="current-datetime"/);
  assert.match(html, /<time id="current-datetime"/);
  assert.match(html, /<a class="brand dashboard-brand"[\s\S]*?Runtime Elipse E3 e Power[\s\S]*?<\/a>/);
  assert.equal((html.match(/class="page-title-mark"/g) || []).length, 1);
  assert.match(html, /page-title-eyebrow">Dashboard de/);
  assert.match(html, /page-title-name">performance SCADA/);
});

test('dashboard clock uses full Portuguese date and Sao Paulo time independently of refresh pause', () => {
  const page = monitoring();
  assert.equal(vm.runInContext("dashboardDateTime(new Date('2026-10-18T22:05:48Z'))", page.context), 'domingo, 18 de outubro de 2026 - 19:05:48');
  assert.equal(vm.runInContext("dashboardDateTime(new Date('2026-10-18T02:05:48Z'))", page.context), 'sábado, 17 de outubro de 2026 - 23:05:48');
  const clockInterval = page.intervals.find(item => item.milliseconds === 1000);
  assert.ok(clockInterval);
  vm.runInContext('paused = true', page.context);
  clockInterval.callback();
  assert.match(vm.runInContext("document.getElementById('current-datetime').textContent", page.context), / - \d{2}:\d{2}:\d{2}$/);
});

test('overview renders a 3D orbit with all current metrics, monitoring and three server summaries', () => {
  const page = monitoring();
  const html = page.html();
  assert.match(html, /class="orbit-stage"/);
  assert.match(html, /data-orbit-motion="active"/);
  assert.equal((html.match(/class="orbit-bubble /g) || []).length, 26);
  assert.equal((html.match(/data-donut-server=/g) || []).length, 3);
  assert.ok(html.includes('aria-label="Alarmes ativos e histórico"'));
  assert.match(html, /id="carousel-next"/);
  assert.match(html, /Foco atualizado a cada 4 s/);
  assert.doesNotMatch(html, /Troca automática|Limites demonstrativos|SERVIDORES MONITORADOS/);
  assert.ok(page.intervals.some(item => item.milliseconds === 4000));
});

test('monitoring has distinct symbols for critical, warning and unavailable states', () => {
  const page = monitoring();
  for (const state of ['critical', 'warning', 'unknown']) {
    const symbol = vm.runInContext(`monitoringSeverityIcon('${state}')`, page.context);
    assert.match(symbol, new RegExp(`data-severity="${state}"`));
    assert.match(symbol, /aria-hidden="true"/);
    assert.match(symbol, /monitoring-icon-mark/);
  }
  assert.equal((page.html().match(/class="monitoring-severity-icon"/g) || []).length, 2);
});

test('compact monitoring cycles through all 18 alarms in nine pages', () => {
  const page = monitoring();
  const seen = new Set();
  for (let index = 0; index < 9; index++) {
    const html = vm.runInContext(`monitoringPage = ${index}; monitoringPanel()`, page.context);
    assert.ok(html.includes(`Página ${index + 1} de 9`));
    assert.doesNotMatch(html, /Troca automática/);
    assert.equal((html.match(/class="compact-alarm /g) || []).length, 2);
    seen.add(html);
  }
  assert.equal(seen.size, 9);
  assert.match(vm.runInContext('monitoringPage = 9; monitoringPanel()', page.context), /Página 1 de 9/);
});

test('absolute CPU alarm is visible independently from trend warmup and expires safely', () => {
  const page = monitoring();
  vm.runInContext(`
    SERVERS[0].metrics.runCPU = 95;
    SERVERS[0].trends.forEach(t => { t.state = 30; t.reason = 'Histórico insuficiente'; });
    SERVERS[0].absoluteAlarms = [{ metric: 'runCPU', limit: 90, state: 20, timestamp: Date.now(), writeStatus: 'disabled' }];
    renderFleet();
  `, page.context);
  assert.equal(vm.runInContext('healthOf(SERVERS[0]).state', page.context), 'critical');
  assert.match(page.html(), /CPU · Limite/);
  assert.match(page.html(), /Limite ≥ 90 %/);
  assert.match(page.html(), /95,0/);
  vm.runInContext('SERVERS[0].absoluteAlarms[0].timestamp = Date.now() - 121000', page.context);
  assert.equal(vm.runInContext('healthOf(SERVERS[0]).signals.find(s => s.kind === "absolute").state', page.context), 'unknown');
});

test('server alarm panel shows absolute value and active status without confusing trends or missing data', () => {
  const page = monitoring();
  const html = vm.runInContext(`serverAlarmPanel({sampleTime:Date.now(),metrics:{runCPU:95,runTRD:180}}, {state:'critical',signals:[
    {metric:'runCPU',kind:'absolute',state:'critical',description:'Limite ≥ 90 %'},
    {metric:'runTRD',state:'warning',description:'4 threads/min'},
    {metric:'runMemory',state:'unknown',description:'Sem dados'}
  ]})`, page.context);
  assert.match(html, /2 alarmes ativos neste servidor/);
  assert.match(html, /E3Run.CPU - Percentual Muito Alto \(95,0 %\)/);
  assert.match(html, /E3Run.Threads - Tendência de Elevação \(180 threads\)/);
  assert.equal((html.match(/>- Ativo</g) || []).length, 2);
  assert.equal((html.match(/>- Indisponível</g) || []).length, 1);
});

test('carousel has no dedicated pause button and respects global pause and server details', () => {
  const page = monitoring();
  const initial = page.html();
  assert.doesNotMatch(initial, /carousel-pause|Pausar carrossel/);
  vm.runInContext('paused = true', page.context);
  page.intervals[0].callback();
  assert.equal(page.html(), initial);
  vm.runInContext('paused = false; activeServerId = "COGCGPRO12"', page.context);
  page.intervals[0].callback();
  assert.equal(vm.runInContext('carouselIndex', page.context), 0);
});

test('fresh real measurements remain visible during trend warmup and partial collection', () => {
  const page = monitoring();
  vm.runInContext(`
    SERVERS[0].collecting = false;
    SERVERS[0].sampleTime = null;
    SERVERS[0].metrics.runCPU = 95;
    SERVERS[0].metrics.runMemory = 62;
    SERVERS[0].metricQuality = {
      runCPU: {good:true,timestamp:Date.now()},
      runMemory: {good:false,timestamp:Date.now()}
    };
    SERVERS[0].trends.forEach(t => {t.state = 30;});
    renderFleet();
  `, page.context);
  assert.equal(vm.runInContext('visibleMetrics(SERVERS[0]).runCPU', page.context), 95);
  assert.equal(vm.runInContext('visibleMetrics(SERVERS[0]).runMemory', page.context), null);
  assert.match(page.html(), /95,0/);
  vm.runInContext(`SERVERS[0].histories = {local:[],remote:[]}; renderDetail(SERVERS[0])`, page.context);
  assert.match(page.html(), /95,0/);
  assert.doesNotMatch(page.html(), /62,0/);
});

test('measurements expire individually and disappear when the API is unavailable', () => {
  const page = monitoring();
  vm.runInContext(`SERVERS[0].metricQuality = {runCPU:{good:true,timestamp:Date.now()-121000}}`, page.context);
  assert.equal(vm.runInContext('currentMetric(SERVERS[0], "runCPU")', page.context), null);
  vm.runInContext(`SERVERS[0].metricQuality.runCPU.timestamp = Date.now()+60000`, page.context);
  assert.equal(vm.runInContext('currentMetric(SERVERS[0], "runCPU")', page.context), null);
  vm.runInContext(`SERVERS[0].metricQuality.runCPU.timestamp = Date.now(); SERVERS[0].apiAvailable = false`, page.context);
  assert.equal(vm.runInContext('currentMetric(SERVERS[0], "runCPU")', page.context), null);
});

test('all 26 metrics participate in the orbit for every configured server', () => {
  const page = monitoring();
  for (let index = 0; index < 3; index++) {
    vm.runInContext(`carouselIndex=${index}; orbitFocusMetricKey=null; renderFleet()`, page.context);
    const fields = new Set([...page.html().matchAll(/data-orbit-metric="([^"]+)"/g)].map(match => match[1]));
    assert.equal(fields.size, 26);
    assert.equal(vm.runInContext('orbitMetrics(SERVERS[carouselIndex]).length', page.context), 26);
  }
});

test('detail displays all metrics and escapes metadata without inventing process health', () => {
  const page = monitoring();
  vm.runInContext(`SERVERS[0].metrics.fileRead='<img src=x onerror=alert(1)>'; SERVERS[0].metrics.serverStatus='Operando'`,page.context);
  let combined = '';
  for (let index = 0; index < 3; index++) {
    vm.runInContext(`detailMetricPage=${index}; renderDetail(SERVERS[0])`,page.context);
    combined += page.html();
  }
  assert.equal((combined.match(/data-metric="/g)||[]).length,26);
  assert.match(combined,/&lt;img/);
  assert.doesNotMatch(combined,/<img/);
  assert.match(combined,/Operando/);
  assert.doesNotMatch(combined,/ESPAÇO LIVRE|ARQUIVO ETL|Reset de contadores|MÉTRICAS DISPONÍVEIS NO PI/);
});

test('orbit advances its focused metric every four seconds and respects pause', () => {
  const page=monitoring();
  const orbitInterval = page.intervals.find(item => item.milliseconds === 4000);
  assert.ok(orbitInterval);
  const first = vm.runInContext('orbitFocusMetricKey', page.context);
  orbitInterval.callback();
  const second = vm.runInContext('orbitFocusMetricKey', page.context);
  assert.notEqual(second, first);
  vm.runInContext('paused=true', page.context);
  orbitInterval.callback();
  assert.equal(vm.runInContext('orbitFocusMetricKey', page.context), second);
});

test('critical and warning metrics are prioritized in the orbit and server rings use equivalent sectors', () => {
  const page = monitoring();
  vm.runInContext(`
    SERVERS[0].absoluteAlarms=[{metric:'runCPU',limit:9,state:20,timestamp:Date.now()}];
    SERVERS[0].trends.find(t=>t.metric==='runMemory').state=10;
    renderFleet();
  `, page.context);
  const ordered = vm.runInContext('orbitMetrics(SERVERS[0]).slice(0, 2).map(metric=>metric.state).join(",")', page.context);
  assert.equal(ordered, 'critical,warning');
  assert.match(page.html(), /orbit-bubble critical priority/);
  assert.match(page.html(), /orbit-bubble warning priority/);
  for (const id of ['COGCGPRO12', 'COGCGPRO34', 'COGCGPRO56']) assert.match(page.html(), new RegExp(`data-donut-server="${id}"`));
  assert.equal((page.html().match(/data-donut-metric="runCPU"/g) || []).length, 3);
  assert.match(fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'styles.css'), 'utf8'), /conic-gradient\(var\(--runCPU\) 0deg 120deg, var\(--runMemory\) 120deg 240deg, var\(--runErrorsPerMinute\) 240deg 360deg\)/);
});

test('reduced motion freezes automatic orbit updates without changing data states', () => {
  const page = monitoring(true);
  const orbitInterval = page.intervals.find(item => item.milliseconds === 4000);
  const focus = vm.runInContext('orbitFocusMetricKey', page.context);
  orbitInterval.callback();
  assert.equal(vm.runInContext('orbitFocusMetricKey', page.context), focus);
  const css = fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'styles.css'), 'utf8');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.orbit-bubble \{ animation: none !important; transition: none !important; \}/);
});

test('topology view exposes filters, a node-link workspace and never invents production sessions', () => {
  const page = monitoring();
  vm.runInContext(`PI_DATA_STATE.simulated=false; location.hash='#topology'; renderRoute()`, page.context);
  const html = page.html();
  assert.match(html, /Topologia OT|TOPOLOGIA OT/);
  assert.match(html, /data-topology-filter="zone"/);
  assert.match(html, /data-topology-filter="protocol"/);
  assert.match(html, /class="topology-canvas"/);
  assert.match(html, /data-topology-motion="active"/);
  assert.equal((html.match(/data-topology-node=/g) || []).length, 3);
  assert.equal((html.match(/data-topology-session=/g) || []).length, 0);
  assert.match(html, /Estado de sessões não confirmado/);
  assert.match(html, /Selecione um ativo/);
  assert.equal(vm.runInContext('topologyModel().sessions.length', page.context), 0);
});

test('topology depth animation pauses with global pause or reduced motion', () => {
  const page = monitoring();
  vm.runInContext(`location.hash='#topology'; paused=true; renderRoute()`, page.context);
  assert.match(page.html(), /data-topology-motion="paused"/);
  const reduced = monitoring(true);
  vm.runInContext(`location.hash='#topology'; renderRoute()`, reduced.context);
  assert.match(reduced.html(), /data-topology-motion="paused"/);
  const css = fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'styles.css'), 'utf8');
  assert.match(css, /@keyframes topology-plane-orbit/);
  assert.match(css, /@keyframes topology-node-depth/);
  assert.match(css, /\.topology-canvas\[data-topology-motion=active\] \.topology-motion-plane \{ animation: topology-plane-orbit/);
});

test('simulated topology renders visible sessions, filters them and opens a contextual asset panel safely', () => {
  const page = monitoring();
  vm.runInContext(`
    PI_DATA_STATE.simulated=true;
    SERVERS[0].name='<img src=x onerror=alert(1)>';
    topologySelectedId=SERVERS[0].id;
    location.hash='#topology';
    renderRoute();
  `, page.context);
  assert.equal((page.html().match(/data-topology-session=/g) || []).length, 2);
  assert.match(page.html(), /Fluxo demonstrativo/);
  assert.match(page.html(), /ATIVO SELECIONADO/);
  assert.match(page.html(), /&lt;img/);
  assert.doesNotMatch(page.html(), /<img/);
  vm.runInContext(`topologyFilters.protocol='Modbus TCP'; renderTopology()`, page.context);
  assert.equal((page.html().match(/data-topology-session=/g) || []).length, 1);
  assert.match(page.html(), /Modbus TCP/);
});

test('active alarms and history rotate independently without empty pages', () => {
  const page = monitoring();
  vm.runInContext(`
    SERVERS.splice(1);
    SERVERS[0].trends.splice(1).forEach(t => SERVERS[0].trends.push({...t,state:0}));
    PI_DATA_STATE.alarmHistory = Array.from({length:8}, (_,i)=>({serverId:'COGCGPRO12',serverName:'COGCGPRO12',state:'warning',title:'Evento '+i,description:'Elevação',observedAt:Date.now()}));
  `, page.context);
  const seen = new Set();
  for (let index=0; index<8; index++) {
    const html = vm.runInContext(`monitoringPage=${index}; monitoringPanel()`, page.context);
    assert.equal((html.match(/class="compact-alarm warning"/g)||[]).length,1);
    assert.equal((html.match(/class="alarm-history-item warning"/g)||[]).length,2);
    assert.doesNotMatch(html,/Nenhum alarme ativo/);
    for (const title of html.matchAll(/Evento (\d)/g)) seen.add(title[1]);
  }
  assert.equal(seen.size,8);
});

test('unavailable or warming up data never produces a green all-clear', () => {
  const page = monitoring();
  vm.runInContext('SERVERS.forEach(s=>s.trends.forEach(t=>{t.state=0})); renderFleet()',page.context);
  assert.match(page.html(),/alarm-status-summary healthy/);
  vm.runInContext('SERVERS[0].trends[0].state=30; SERVERS[0].trends[0].reason="Histórico insuficiente"; renderFleet()',page.context);
  assert.match(page.html(),/alarm-status-summary unknown/);
  assert.doesNotMatch(page.html(),/alarm-status-summary healthy/);
  assert.match(page.html(),/1 com diagnóstico pendente/);
  vm.runInContext('SERVERS.forEach(s=>{s.collecting=false;s.apiAvailable=false}); renderFleet()',page.context);
  assert.match(page.html(),/3 com diagnóstico pendente/);
  assert.doesNotMatch(page.html(),/Nenhum alarme ativo/);
});

test('cards reflect alarm states and only actual percentages get a proportional indicator', () => {
  const page = monitoring();
  const html = vm.runInContext(`metricCards([
    {key:'runCPU',label:'CPU',unit:'%',value:95},
    {key:'runTRD',label:'Threads',value:200},
    {key:'serverStatus',label:'Status',value:'Ativo'},
    {key:'runMemory',label:'Memória',unit:'%',value:null}
  ], {signals:[{metric:'runCPU',state:'critical'},{metric:'runTRD',state:'warning'}]})`,page.context);
  assert.match(html,/metric-card critical/);
  assert.match(html,/metric-card warning/);
  assert.match(html,/metric-card neutral text-metric/);
  assert.match(html,/metric-card unknown/);
  assert.equal((html.match(/class="metric-indicator"/g)||[]).length,1);
  assert.match(html,/width:95%/);
  assert.match(html,/Sem dados/);
});

test('detail rotation respects global pause and keyboard focus', () => {
  const page = monitoring();
  vm.runInContext('activeServerId="COGCGPRO12"; paused=true; renderDetail(SERVERS[0])',page.context);
  page.intervals[0].callback();
  assert.equal(vm.runInContext('detailMetricPage',page.context),0);
  vm.runInContext('paused=false; document.activeElement={closest:()=>true}',page.context);
  page.intervals[0].callback();
  assert.equal(vm.runInContext('detailMetricPage',page.context),0);
  vm.runInContext('document.activeElement=null',page.context);
  page.intervals[0].callback();
  assert.equal(vm.runInContext('detailMetricPage',page.context),1);
});

test('reading context counts fresh points separately from process alarm severity', () => {
  const page = monitoring();
  const html = vm.runInContext('readingContext(SERVERS)',page.context);
  assert.match(html,/data-reading-state="partial"/);
  assert.match(html,/18 \/ 78 pontos · 3 servidores/);
  vm.runInContext('SERVERS[0].metricQuality={runCPU:{good:false,timestamp:Date.now()}}',page.context);
  assert.equal(vm.runInContext('readingCoverage(SERVERS).available',page.context),17);
  vm.runInContext('SERVERS[1].sampleTime=Date.now()-121000; SERVERS[2].apiAvailable=false',page.context);
  assert.equal(vm.runInContext('readingCoverage(SERVERS).available',page.context),5);
  vm.runInContext('SERVERS[0].apiAvailable=false',page.context);
  assert.match(vm.runInContext('readingContext(SERVERS)',page.context),/Sem leituras recentes/);
  vm.runInContext('paused=true',page.context);
  assert.match(vm.runInContext('readingContext(SERVERS)',page.context),/Atualização pausada/);
});

test('complete fresh readings are not interpreted as absence of alarms', () => {
  const page = monitoring();
  vm.runInContext(`SERVERS.forEach(server=>{
    const points=serverMetricGroups({}).flatMap(group=>group.items);
    server.metrics=Object.fromEntries(points.map(point=>[point.key,10]));
  }); renderFleet()`,page.context);
  assert.match(page.html(),/data-reading-state="complete"/);
  assert.match(page.html(),/78 \/ 78 pontos/);
  assert.match(page.html(),/18 alarmes ativos em 3 servidores/);
  assert.doesNotMatch(page.html(),/Nenhum alarme ativo/);
});

test('alarm type symbols distinguish absolute limits from rising trends', () => {
  const page = monitoring();
  vm.runInContext('SERVERS[0].absoluteAlarms=[{metric:"runCPU",limit:9,state:20,timestamp:Date.now()}]',page.context);
  const html=vm.runInContext('monitoringPanel()',page.context);
  assert.match(html,/data-alarm-kind="absolute"/);
  assert.match(html,/data-alarm-kind="trend"/);
  assert.notEqual(vm.runInContext('contextIcon("absolute")',page.context),vm.runInContext('contextIcon("trend")',page.context));
});

test('history uses known metric labels without interpreting untrusted titles as markup', () => {
  const page = monitoring();
  const html=vm.runInContext(`alarmHistoryPanel([
    {serverId:'COGCGPRO12',serverName:'COGCGPRO12',state:'critical',title:'runMemory',description:'Limite',observedAt:Date.now()},
    {serverId:'COGCGPRO12',serverName:'COGCGPRO12',state:'warning',title:'<img src=x>',description:'Elevação',observedAt:Date.now()}
  ])`,page.context);
  assert.match(html,/Crítico · RAM/);
  assert.match(html,/&lt;img src=x&gt;/);
  assert.doesNotMatch(html,/<img|runMemory/);
});
