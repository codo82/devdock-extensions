// Swagger: estensione solo frontend, caricata come tab con i suoi file
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { startServer } = require('devdock/testkit');

const EXT = path.join(__dirname, '..');
let srv;
before(async () => { srv = await startServer({ projects: [] }, { install: [EXT] }); });
after(() => srv?.stop());

test('estensione swagger caricata come tab, senza backend', async () => {
  const ext = (await srv.request('GET', '/api/core/extensions')).json.find(e => e.code === 'swagger');
  assert.equal(ext.state, 'ok');
  assert.equal(ext.position, 'tab');
  assert.deepEqual(Object.keys(ext.frontend).filter(k => k !== 'preload').sort(), ['css', 'html', 'js', 'sidebar']);
  for (const f of ['view.html', 'sidebar.html', 'view.js', 'style.css']) {
    assert.equal((await srv.request('GET', `/ext/swagger/${f}`)).status, 200, f);
  }
  assert.equal((await srv.request('GET', '/api/ext/swagger/anything')).status, 404);
});
