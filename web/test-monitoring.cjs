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
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'servers.js'), 'utf8'), context);
  vm.runInContext(`
    SERVERS.splice(0, SERVERS.length, ...['COGCGPRO12', 'COGCGPRO34', 'COGCGPRO56'].map(id => ({
      id, name: id, site: 'Teste', environment: 'Teste', role: '', collecting: true, sampleTime: Date.now(),
      metrics: Object.fromEntries(['runCPU','runMemory','runPVT','runErrorsPerMinute','runLocalPending','runRemotePending'].map(key => [key, 10])),
      trends: ['runCPU','runMemory','runPVT','runErrorsPerMinute','runLocalPending','runRemotePending'].map(metric => ({ metric, state: 10, slope: 1, score: 2, windowSeconds: 600 }))
    })));
    SCADA_SERVER_POSITIONS.splice(0, SCADA_SERVER_POSITIONS.length, ...SERVERS.map(s => s.id));
  `, context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8'), context);
  return { context, intervals, html: () => elements.get('main').innerHTML };
}

test('overview cycles through all servers and keeps compact monitoring', () => {
  const page = monitoring();
  assert.equal(page.intervals[0].milliseconds, 10000);
  for (const id of ['COGCGPRO12', 'COGCGPRO34', 'COGCGPRO56']) {
    assert.ok(page.html().includes('<h1>' + id + '</h1>'));
    assert.equal((page.html().match(/class="metric-card"/g) || []).length, 8);
    assert.ok(page.html().includes('MONITORAMENTO'));
    assert.ok(!page.html().includes('Limites demonstrativos'));
    assert.ok(!page.html().includes('SERVIDORES MONITORADOS'));
    page.intervals[0].callback();
  }
  assert.ok(page.html().includes('<h1>COGCGPRO12</h1>'));
});

test('compact monitoring cycles through all 18 alarms in nine pages', () => {
  const page = monitoring();
  const seen = new Set();
  for (let index = 0; index < 9; index++) {
    const html = vm.runInContext(`monitoringPage = ${index}; monitoringPanel()`, page.context);
    assert.ok(html.includes(`Página ${index + 1} de 9`));
    assert.equal((html.match(/class="compact-alarm /g) || []).length, 2);
    seen.add(html);
  }
  assert.equal(seen.size, 9);
  assert.match(vm.runInContext('monitoringPage = 9; monitoringPanel()', page.context), /Página 1 de 9/);
});

test('carousel respects its own pause, global pause and server details', () => {
  const page = monitoring();
  const initial = page.html();
  for (const expression of ['carouselPaused = true', 'carouselPaused = false; paused = true', 'paused = false; activeServerId = "COGCGPRO12"']) {
    vm.runInContext(expression, page.context);
    page.intervals[0].callback();
    assert.equal(page.html(), initial);
  }
});
