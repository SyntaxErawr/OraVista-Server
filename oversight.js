const { AsyncLocalStorage } = require('node:async_hooks');
const fs = require('node:fs');
const path = require('node:path');

function installOversight(app, db) {
  const context = new AsyncLocalStorage();
  app.use((req, res, next) => context.run({ req }, next));
  const connect = db.connect.bind(db);
  db.connect = async () => {
    const client = await connect();
    const req = context.getStore()?.req;
    try {
      await client.query("SELECT set_config('oravista.actor', $1, false), set_config('oravista.action', $2, false)", [JSON.stringify(req?.actor ? { id: req.actor.id, role: req.actor.role, name: [req.actor.first_name || req.actor.firstName, req.actor.last_name || req.actor.lastName].filter(Boolean).join(' ') } : {}), req ? `${req.method} ${req.path}` : 'System']);
      return client;
    } catch (error) { client.release(); throw error; }
  };
  db.query = async (...args) => { const client = await db.connect(); try { return await client.query(...args); } finally { client.release(); } };

  const filters = (query, audit) => {
    const values = [], conditions = [];
    const add = (sql, value) => { values.push(value); conditions.push(sql.replace('?', `$${values.length}`)); };
    for (const field of ['from', 'to']) if (query[field]) {
      const value = String(query[field]);
      const parsed = new Date(`${value}T00:00:00Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new Error('Enter valid filter dates.');
      add(field === 'from' ? "created_at >= (?::date::timestamp AT TIME ZONE 'Asia/Manila')" : "created_at < ((?::date + 1)::timestamp AT TIME ZONE 'Asia/Manila')", value);
    }
    if (query.from && query.to && query.from > query.to) throw new Error('Start date must be before end date.');
    if (query.branch) add('branch = ?', String(query.branch));
    if (query.q) add(audit ? "concat_ws(' ', actor_name, actor_role, action, entity, entity_id) ILIKE ?" : "concat_ws(' ', patient_name, service, booking_ref, collector_name, reference, id) ILIKE ?", `%${String(query.q).slice(0, 200)}%`);
    return { where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', values };
  };
  const register = (route, table, audit) => app.get(route, async (req, res) => {
    let filter;
    try { filter = filters(req.query, audit); } catch (error) { return res.status(400).json({ message: error.message }); }
    const page = Math.max(1, Math.min(100000, parseInt(req.query.page, 10) || 1));
    try {
      const client = await db.connect();
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const totals = await client.query(`SELECT COUNT(*) AS count ${audit ? '' : ', COALESCE(SUM(amount), 0) AS received'} FROM ${table} ${filter.where}`, filter.values);
        const exporting = req.query.format === 'csv';
        const records = await client.query(`SELECT * FROM ${table} ${filter.where} ORDER BY created_at DESC, id DESC${exporting ? '' : ` LIMIT 20 OFFSET $${filter.values.length + 1}`}`, exporting ? filter.values : [...filter.values, (page - 1) * 20]);
        const branches = await client.query(`SELECT DISTINCT branch FROM ${table} WHERE branch IS NOT NULL ORDER BY branch`);
        await client.query('COMMIT');
        if (exporting) {
          const fields = audit ? ['id','created_at','actor_name','actor_role','action','entity','entity_id','branch','changes'] : ['id','created_at','patient_name','booking_ref','branch','service','amount','method','reference','collector_name'];
          const quote = value => {
            let text = value instanceof Date ? value.toISOString() : (typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value ?? ''));
            if (/^[\s]*[=+@\-]/.test(text)) text = "'" + text;
            return '"' + text.replace(/"/g, '""') + '"';
          };
          const csv = '\uFEFF' + [fields.map(quote).join(','), ...records.rows.map(row => fields.map(field => quote(row[field])).join(','))].join('\r\n');
          return res.type('text/csv').set('Content-Disposition', `attachment; filename="OraVista_${audit ? 'Audit' : 'Transactions'}.csv"`).send(csv);
        }
        res.json({ records: records.rows, count: Number(totals.rows[0].count), received: totals.rows[0].received, branches: branches.rows.map(row => row.branch), page });
      } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    } catch (error) { console.error('Oversight query failed:', error.message); res.status(500).json({ message: 'Unable to load records.' }); }
  });
  return {
    registerRoutes: () => { register('/api/admin/transactions', 'payment_events', false); register('/api/admin/audit-logs', 'audit_events', true); },
    initialize: () => db.query(fs.readFileSync(path.join(__dirname, 'migrations/20261008_transaction_audit.sql'), 'utf8')),
    recordAuth: (req, user, success) => db.query("INSERT INTO audit_events(actor_id, actor_name, actor_role, action, entity, entity_id, changes) VALUES($1,$2,$3,$4,'authentication',$1,$5::jsonb)", [user?.id ? String(user.id) : null, user ? [user.firstName || user.first_name,user.lastName || user.last_name].filter(Boolean).join(' ') : 'Unidentified', user?.role || null, `${success ? 'SUCCESS' : 'FAILED'} ${req.path}`, JSON.stringify({ outcome: success ? 'success' : 'failed' })]),
  };
}

function paymentDelta(previous, paid, method, reference) {
  const cents = value => Math.round(Number(value || 0) * 100);
  const delta = cents(paid) - cents(previous);
  if (delta < 0) throw Object.assign(new Error('Recorded payments cannot be reduced. Correct payments through a reviewed reversal rather than overwriting history.'), { status: 400 });
  if (delta > 0 && !['Cash', 'E-wallet'].includes(method)) throw Object.assign(new Error('Select Cash or E-wallet for this payment.'), { status: 400 });
  if (delta > 0 && method === 'E-wallet' && !String(reference || '').trim()) throw Object.assign(new Error('Enter the e-wallet payment reference.'), { status: 400 });
  return delta / 100;
}
module.exports = { installOversight, paymentDelta };
