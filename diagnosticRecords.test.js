const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSaveFinalDiagnosis } = require('./diagnosticRecords');

function fixture({ previous = {}, exists = true, failUpdate = false, failUpload = false } = {}) {
  const calls = [];
  const uploads = [];
  const removed = [];
  let saved;
  const client = {
    async query(sql, params) {
      calls.push(sql);
      if (sql.startsWith('SELECT')) return { rows: exists ? [{ ai_findings: previous }] : [] };
      if (sql.startsWith('UPDATE')) {
        if (failUpdate) throw new Error('Database write failed');
        saved = { id: 12, patient_id: 7, clinical_notes: params[0], ai_findings: JSON.parse(params[1]) };
        return { rows: [saved] };
      }
      return { rows: [] };
    },
    release() { calls.push('release'); },
  };
  const bucket = {
    async upload(name, bytes, options) { uploads.push({ name, bytes, options }); return { error: failUpload ? new Error('Storage failed') : null }; },
    async remove(names) { removed.push(...names); return { error: null }; },
  };
  const handler = createSaveFinalDiagnosis({ db: { connect: async () => client }, supabase: { storage: { from: name => {
    assert.equal(name, 'file-record'); return bucket;
  } } } });
  const req = { params: { id: '12' }, body: { patient_id: '7', clinical_notes: 'Dentist final notes', annotations: '[]' } };
  const res = { statusCode: 200, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } };
  const png = { mimetype: 'image/png', buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]) };
  return { handler, req, res, png, calls, uploads, removed, saved: () => saved };
}

test('new final save stores image, final annotations and notes together without restoring deleted predictions', async () => {
  const f = fixture({ previous: { predictions: [{ name: 'Deleted AI finding' }] } });
  f.req.file = f.png;
  f.req.body.annotations = JSON.stringify([{ name: 'Dentist finding', box: { x_min: 0.1, y_min: 0.2, width: 0.3, height: 0.4 } }]);
  await f.handler(f.req, f.res);
  assert.equal(f.res.statusCode, 200);
  assert.equal(f.saved().clinical_notes, 'Dentist final notes');
  assert.equal(f.saved().ai_findings.human_verified, true);
  assert.deepEqual(f.saved().ai_findings.annotations.map(a => a.name), ['Dentist finding']);
  assert.equal(f.saved().ai_findings.xray_image_path, `uploads/${f.uploads[0].name}`);
  assert.match(f.uploads[0].name, /^record_diagnostic_12_.+\.png$/);
  assert.equal(f.calls.at(-2), 'COMMIT');
});

test('later save retains the image and honors an intentionally empty final annotations list', async () => {
  const imagePath = 'uploads/record_diagnostic_12_original.png';
  const f = fixture({ previous: { human_verified: true, xray_image_path: imagePath, annotations: [{ name: 'Removed' }] } });
  await f.handler(f.req, f.res);
  assert.equal(f.res.statusCode, 200);
  assert.deepEqual(f.saved().ai_findings.annotations, []);
  assert.equal(f.saved().ai_findings.xray_image_path, imagePath);
  assert.equal(f.uploads.length, 0);
});

test('diagnosis from another patient is rejected before uploading or writing', async () => {
  const f = fixture({ exists: false });
  f.req.file = f.png;
  await f.handler(f.req, f.res);
  assert.equal(f.res.statusCode, 404);
  assert.equal(f.uploads.length, 0);
  assert.equal(f.saved(), undefined);
  assert.ok(f.calls.includes('ROLLBACK'));
});

test('new final diagnosis requires an original image, while legacy saved notes remain editable', async () => {
  const f = fixture();
  await f.handler(f.req, f.res);
  assert.equal(f.res.statusCode, 400);
  assert.equal(f.saved(), undefined);
  const legacy = fixture({ previous: { human_verified: true } });
  await legacy.handler(legacy.req, legacy.res);
  assert.equal(legacy.res.statusCode, 200);
  assert.equal(legacy.saved().ai_findings.xray_image_path, null);
});

test('database failure rolls back and removes the newly uploaded image', async () => {
  const f = fixture({ failUpdate: true });
  f.req.file = f.png;
  await f.handler(f.req, f.res);
  assert.equal(f.res.statusCode, 500);
  assert.equal(f.saved(), undefined);
  assert.ok(f.calls.includes('ROLLBACK'));
  assert.ok(!f.calls.includes('COMMIT'));
  assert.deepEqual(f.removed, [f.uploads[0].name]);
});

test('storage failure never finalizes the diagnosis', async () => {
  const f = fixture({ failUpload: true });
  f.req.file = f.png;
  await f.handler(f.req, f.res);
  assert.equal(f.res.statusCode, 500);
  assert.equal(f.saved(), undefined);
  assert.ok(f.calls.includes('ROLLBACK'));
});

test('invalid image bytes and out-of-bounds coordinates are rejected', async () => {
  const f = fixture();
  f.req.file = { mimetype: 'image/png', buffer: Buffer.from('not a PNG') };
  await f.handler(f.req, f.res);
  assert.equal(f.res.statusCode, 400);
  assert.equal(f.calls.length, 0);
  f.req.file = f.png;
  f.req.body.annotations = JSON.stringify([{ name: 'Outside image', box: { x_min: 0.9, y_min: 0, width: 0.4, height: 0.2 } }]);
  await f.handler(f.req, f.res);
  assert.equal(f.res.statusCode, 400);
  assert.equal(f.calls.length, 0);
});

test('missing multipart fields are rejected without opening a database transaction', async () => {
  const f = fixture();
  f.req.body = undefined;
  await f.handler(f.req, f.res);
  assert.equal(f.res.statusCode, 400);
  assert.equal(f.calls.length, 0);
});
