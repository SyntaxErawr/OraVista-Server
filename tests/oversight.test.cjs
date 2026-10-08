const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { installOversight, paymentDelta } = require('../oversight');
const { accessControl } = require('../access-control');

test('payment deltas use cents, require collection details and preserve historical amounts', () => {
  assert.equal(paymentDelta(500, 1500, 'Cash'), 1000);
  assert.equal(paymentDelta(1500, 1500, ''), 0);
  assert.equal(paymentDelta(0.1, 0.3, 'Cash'), 0.2);
  assert.throws(() => paymentDelta(100, 50, 'Cash'), /cannot be reduced/);
  assert.throws(() => paymentDelta(0, 100, ''), /Select Cash/);
  assert.throws(() => paymentDelta(0, 100, 'E-wallet', ''), /reference/);
  assert.equal(paymentDelta(0, 100, 'E-wallet', 'GC-1'), 100);
});

test('oversight endpoints protect admin access, parameterize filters, export all rows and reset pooled actor context', async t => {
  const calls = [];
  const record = { id: 1, patient_name: '=BAD()', branch: 'Main Branch', amount: '100.00', created_at: '2026-10-08T00:00:00Z' };
  const client = { release() {}, async query(sql, values) {
    calls.push({ sql, values });
    if (sql.includes('COUNT(*)')) return { rows: [{ count: '25', received: '2500.00' }] };
    if (sql.includes('SELECT DISTINCT branch')) return { rows: [{ branch: 'Main Branch' }] };
    if (sql.includes('SELECT * FROM')) return { rows: [record] };
    return { rows: [] };
  } };
  const db = { connect: async () => client };
  const app = express();
  const oversight = installOversight(app, db);
  app.use(accessControl({ db, auth: { session: async token => {
    if (!token) throw Object.assign(new Error('Sign in'), { status: 401 });
    return { id: 7, role: token, first_name: 'Test', last_name: 'Actor' };
  } } }));
  oversight.registerRoutes();
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.on('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const route of ['/api/admin/transactions', '/api/admin/audit-logs']) {
    assert.equal((await fetch(base + route)).status, 401);
    assert.equal((await fetch(base + route, { headers: { Authorization: 'Bearer staff' } })).status, 403);
    assert.equal((await fetch(base + route, { headers: { Authorization: 'Bearer patient' } })).status, 403);
  }
  const headers = { Authorization: 'Bearer admin' };
  let response = await fetch(base + '/api/admin/transactions?from=2026-10-01&to=2026-10-08&branch=Main%20Branch&page=2&q=Test', { headers });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).received, '2500.00');
  const query = calls.find(item => item.sql.includes('LIMIT 20'));
  assert.deepEqual(query.values, ['2026-10-01','2026-10-08','Main Branch','%Test%',20]);
  assert.match(calls.find(item => item.sql.includes('set_config')).values[0], /Test Actor/);
  response = await fetch(base + '/api/admin/transactions?format=csv', { headers });
  assert.match(await response.text(), /'=BAD\(\)/);
  assert.ok(calls.some(item => item.sql.includes('SELECT * FROM payment_events') && !item.sql.includes('LIMIT')));
  assert.equal((await fetch(base + '/api/admin/transactions?from=2026-02-30', { headers })).status, 400);
  await db.query('SELECT 1');
  assert.equal(calls.filter(item => item.sql.includes('set_config')).at(-1).values[0], '{}');
});
