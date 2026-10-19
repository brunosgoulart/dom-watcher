'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function monitoring() {
  const elements = new Map();
  const intervals = [];
  const document = {
    activeElement: null,
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, { innerHTML: '', value: '', addEventListener() {}, setAttribute() {} });
      return elements.get(id);
    }
  };
  const context = vm.createContext({ document, location: { hash: '#overview' }, window: { addEventListener() {} },
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

test('overview cycles through all servers and keeps compact monitoring', () => {
  const page = monitoring();
  assert.equal(page.intervals[0].milliseconds, 10000);
  for (const id of ['COGCGPRO12', 'COGCGPRO34', 'COGCGPRO56']) {
    assert.ok(page.html().includes('<h1>' + id + '</h1>'));
    assert.equal((page.html().match(/class="metric-card"/g) || []).length, 8);
    assert.ok(page.html().includes('MONITORAMENTO'));
    assert.doesNotMatch(page.html(), /Troca automática/);
    assert.ok(!page.html().includes('Limites demonstrativos'));
    assert.ok(!page.html().includes('SERVIDORES MONITORADOS'));
    page.intervals[0].callback();
  }
  assert.ok(page.html().includes('<h1>COGCGPRO12</h1>'));
});

test('monitoring has distinct large symbols for critical, warning and unavailable states', () => {
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
  const html = vm.runInContext(`serverAlarmPanel({metrics:{runCPU:95,runTRD:180}}, {state:'critical',signals:[
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
  for (const expression of ['paused = true', 'paused = false; activeServerId = "COGCGPRO12"']) {
    vm.runInContext(expression, page.context);
    page.intervals[0].callback();
    assert.equal(page.html(), initial);
  }
});
