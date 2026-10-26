'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..', '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('wallboard keeps the 3D operational orbit and accessible controls', () => {
  const html = read('web/index.html'); const js = read('web/app.js'); const css = read('web/styles.css');
  assert.match(html, /Monitor das Aplicações SCADA/); assert.match(html, /id="orbit-workspace"/); assert.match(html, /id="motion-toggle"/);
  assert.match(js, /GET \/api\/v1\/status|\/api\/v1\/status/); assert.match(js, /escapeHtml/);
  assert.match(js, /runCPU/); assert.match(js, /runMemory/); assert.match(js, /runErrorsPerMinute/);
  assert.match(js, /radiusX/); assert.match(js, /--x:\$\{x\}px/);
  assert.match(js, /data-orbit-key/); assert.match(js, /currentKeys/);
  assert.match(js, /focusKey/); assert.match(js, /chartHistory/); assert.match(js, /renderTrend/);
  assert.match(js, /Última coleta:/); assert.match(js, /metricQuality\?\.\[item\.key\]\?\.timestamp/);
  assert.match(css, /perspective:1100px/); assert.match(css, /translate3d/);
  assert.match(css, /transition:transform 1850ms/);
  assert.match(css, /prefers-reduced-motion/); assert.match(js, /motionPaused/);
});

test('preview keeps the API read-only and avoids changing backend routing', () => {
  const preview = read('tools/interface_preview.py');
  assert.match(preview, /\/api\/v1\/status/); assert.match(preview, /HTTPConnection\("127\.0\.0\.1"/);
  assert.doesNotMatch(preview, /do_POST/);
});
