/* Version: 1.0 | Date: 14/10/2026
Changes: Verified frontend acceptance of PI and local simulation API payloads and rejection of unknown sources. */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');

function createContext() {
  const context = vm.createContext({ console, AbortController, setTimeout: () => 0, clearTimeout: () => {} });
  for (const file of ['servers.js', 'pi-config.js', 'pi-data-source.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, file), 'utf8'), context, { filename: file });
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
    cwd: path.join(__dirname, '..', 'scada_api'), encoding: 'utf8',
  }));
}

for (const source of ['af-sdk', 'pi-sdk-com', 'simulated']) {
  test(`frontend accepts real backend payload for ${source}`, () => {
    const context = createContext();
    context.payload = apiPayload(source);
    const normalized = vm.runInContext('normalizeStatus(payload)', context);
    assert.equal(normalized.servers[0].id, 'test');
    assert.equal(normalized.servers[0].collecting, false);
  });
}

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
