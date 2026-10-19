/* Version: 1.0 | Date: 14/10/2026
Changes: Verified the operational PI API contract and rejection of unsupported sources. */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');

function createContext(allowSimulatedData = false) {
  const context = vm.createContext({ console, AbortController, setTimeout: () => 0, clearTimeout: () => {} });
  for (const file of ['servers.js', 'pi-config.js', 'pi-data-source.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'web', file), 'utf8');
    vm.runInContext(file === 'pi-config.js' && allowSimulatedData ? source.replace('allowSimulatedData: false', 'allowSimulatedData: true') : source, context, { filename: file });
  }
  return context;
}

function apiPayload(source) {
  // Generate a real backend payload without loading either installed PI SDK.
  const code = [
    'import json',
    'from server import SnapshotStore',
    `config = {"piAdapter": ${JSON.stringify(source)}, "staleSeconds": 120, "servers": [{"id": "test", "tags": {}}]}`,
    'store = SnapshotStore(config)',
    'store.poll()',
    'print(json.dumps(store.get()))',
  ].join('\n');
  return JSON.parse(execFileSync(process.env.PYTHON || 'python', ['-B', '-c', code], {
    cwd: path.join(__dirname, '..', '..', 'scada_api'), encoding: 'utf8',
  }));
}

for (const source of ['af-sdk', 'pi-sdk-com']) {
  test(`frontend accepts real backend payload for ${source}`, () => {
    const context = createContext();
    context.payload = apiPayload(source);
    const normalized = vm.runInContext('normalizeStatus(payload)', context);
    assert.equal(normalized.servers[0].id, 'test');
    assert.equal(normalized.servers[0].collecting, false);
  });
}

test('frontend preserves absolute alarms and rejects duplicate or invalid limits', () => {
  const context = createContext();
  context.payload = apiPayload('af-sdk');
  context.payload.servers[0].absoluteAlarms = [{ metric: 'runCPU', state: 20, limit: 90, timestamp: Date.now() }];
  assert.equal(vm.runInContext('normalizeStatus(payload).servers[0].absoluteAlarms[0].limit', context), 90);
  context.payload.servers[0].absoluteAlarms.push({...context.payload.servers[0].absoluteAlarms[0]});
  assert.throws(() => vm.runInContext('normalizeStatus(payload)', context), /absoluto inválidos/);
  context.payload.servers[0].absoluteAlarms = [{ metric: 'runCPU', state: 20, limit: -1 }];
  assert.throws(() => vm.runInContext('normalizeStatus(payload)', context), /absoluto inválidos/);
});

test('simulation requires explicit preview permission and is rejected operationally', () => {
  const payload = apiPayload('simulated');
  const operational = createContext();
  operational.payload = payload;
  assert.throws(() => vm.runInContext('normalizeStatus(payload)', operational), /incompatível/);
  const preview = createContext(true);
  preview.payload = payload;
  assert.equal(vm.runInContext('normalizeStatus(payload).servers[0].id', preview), 'test');
});

test('frontend rejects unknown API sources', () => {
  const context = createContext();
  context.payload = apiPayload('af-sdk');
  context.payload.source = 'unexpected';
  assert.throws(() => vm.runInContext('normalizeStatus(payload)', context), /incompatível/);
});

test('AF SDK polling preserves adapter identity and reports a valid API response', async () => {
  const context = createContext();
  const payload = apiPayload('af-sdk');
  context.fetch = async () => ({ ok: true, json: async () => payload });
  let updates = 0;
  context.updated = () => updates++;
  vm.runInContext('startDataSource(updated, () => false)', context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(updates, 1);
  assert.equal(vm.runInContext('PI_DATA_STATE.source', context), 'af-sdk');
  assert.equal(vm.runInContext('PI_DATA_STATE.status', context), 'not-configured');
});
