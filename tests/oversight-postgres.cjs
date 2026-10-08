// Run with NODE_PATH pointing to an installed @electric-sql/pglite test engine.
// Uses an isolated in-memory PostgreSQL database, never production credentials.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
(async () => {
  const db = new PGlite();
  await db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY, first_name TEXT, last_name TEXT, password TEXT, branch TEXT);
    CREATE TABLE appointments(id INTEGER PRIMARY KEY, user_id INTEGER, branch TEXT, status TEXT, amount NUMERIC, billing_status TEXT, receipt_details JSONB);
    CREATE TABLE patient_records(id INTEGER PRIMARY KEY, file_name TEXT);
    CREATE TABLE ai_diagnostics(id INTEGER PRIMARY KEY, clinical_notes TEXT, ai_findings JSONB);`);
  const migration = fs.readFileSync(path.join(__dirname, '../migrations/20261008_transaction_audit.sql'), 'utf8');
  await db.exec(migration);
  await db.exec(migration);
  await db.query("SELECT set_config('oravista.actor',$1,false),set_config('oravista.action','PUT /api/update-profile',false)", [JSON.stringify({ id: 7, name: 'Staff User', role: 'staff' })]);
  await db.exec("INSERT INTO users VALUES(1,'Jane','Patient','SECRET_PASSWORD','Main Branch'); UPDATE users SET first_name='Updated',password='ANOTHER_SECRET' WHERE id=1;");
  let events = (await db.query('SELECT * FROM audit_events ORDER BY id')).rows;
  assert.equal(events.length, 2);
  assert.equal(events[1].actor_id, '7');
  assert.deepEqual(events[1].changes.first_name, { before: 'Jane', after: 'Updated' });
  assert.ok(!JSON.stringify(events).includes('SECRET'));
  await db.exec("INSERT INTO ai_diagnostics VALUES(1,'PRIVATE_CLINICAL_NOTES','{\"private\":true}');");
  assert.ok(!JSON.stringify((await db.query('SELECT * FROM audit_events')).rows).includes('PRIVATE_CLINICAL'));
  await assert.rejects(db.exec('UPDATE audit_events SET actor_name=\'Forged\''), /cannot be modified/);
  await assert.rejects(db.exec('TRUNCATE audit_events'), /cannot be modified/);
  await db.exec("INSERT INTO payment_events(appointment_id,amount,method,collector_id,branch) VALUES(1,100,'Cash','7','Main Branch');");
  await assert.rejects(db.exec('DELETE FROM payment_events'), /cannot be modified/);
  const before = (await db.query('SELECT COUNT(*) AS count FROM audit_events')).rows[0].count;
  await db.exec("BEGIN; UPDATE users SET first_name='Rolled Back' WHERE id=1; ROLLBACK;");
  assert.equal((await db.query('SELECT COUNT(*) AS count FROM audit_events')).rows[0].count, before);
  assert.equal((await db.query('SELECT first_name FROM users WHERE id=1')).rows[0].first_name, 'Updated');
  await db.query('DELETE FROM users WHERE id=1');
  assert.equal((await db.query('SELECT entity_id FROM audit_events ORDER BY id DESC LIMIT 1')).rows[0].entity_id, '1');
  console.log('PostgreSQL migration passed: repeat initialization, attributed audit writes, redaction, immutable history, rollback and deletion capture.');
  await db.close();
})().catch(error => { console.error(error); process.exitCode = 1; });
