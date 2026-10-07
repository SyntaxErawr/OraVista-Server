const multer = require('multer');
const crypto = require('crypto');

const MAX_XRAY_BYTES = 20 * 1024 * 1024;
const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_XRAY_BYTES, files: 1, fieldSize: 1024 * 1024 },
}).single('xray');

function imageType(file) {
  if (!file) return null;
  const bytes = file.buffer;
  if (file.mimetype === 'image/png' && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { extension: 'png', contentType: 'image/png' };
  }
  if (['image/jpeg', 'image/jpg'].includes(file.mimetype) && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
    return { extension: 'jpg', contentType: 'image/jpeg' };
  }
  return null;
}

function validateAnnotations(annotations) {
  return Array.isArray(annotations) && annotations.every(annotation => {
    if (!annotation || typeof annotation.name !== 'string' || !annotation.name.trim()) return false;
    if (annotation.box == null) return true;
    const { x_min: x, y_min: y, width, height } = annotation.box;
    return [x, y, width, height].every(Number.isFinite) && x >= 0 && y >= 0 &&
      width > 0 && height > 0 && x + width <= 1.000001 && y + height <= 1.000001;
  });
}

// Save directly to the table shared with the imaging service. Only this server
// assigns storage paths; client-supplied URLs never become persistent images.
function createSaveFinalDiagnosis({ db, supabase }) {
  return async (req, res) => {
    const body = req.body || {};
    const id = Number(req.params.id);
    const patientId = Number(body.patient_id);
    let annotations;
    try { annotations = JSON.parse(body.annotations); } catch { /* validated below */ }
    if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(patientId) || patientId <= 0 ||
        typeof body.clinical_notes !== 'string' || !validateAnnotations(annotations)) {
      return res.status(400).json({ message: 'Invalid diagnosis, patient, notes, or annotation coordinates.' });
    }
    const type = imageType(req.file);
    if (req.file && !type) return res.status(400).json({ message: 'The X-ray must be a valid PNG or JPEG image.' });
    let client;
    let uploadedName;
    let committed = false;
    try {
      client = await db.connect();
      await client.query('BEGIN');
      const { rows } = await client.query(
        'SELECT ai_findings FROM ai_diagnostics WHERE diagnosis_id = $1 AND patient_id = $2 FOR UPDATE',
        [id, patientId],
      );
      if (!rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ message: 'This diagnosis does not belong to the selected patient. Upload and analyze the image again.' });
      }
      const previous = rows[0].ai_findings || {};
      let imagePath = previous.xray_image_path || null;
      if (req.file) {
        if (!supabase) throw new Error('X-ray storage is not configured. Please contact the clinic administrator.');
        const filename = `record_diagnostic_${id}_${crypto.randomUUID()}.${type.extension}`;
        const { error } = await supabase.storage.from('file-record').upload(filename, req.file.buffer, {
          contentType: type.contentType, upsert: false,
        });
        if (error) throw new Error('Unable to store the X-ray. Please try saving again.');
        uploadedName = filename;
        imagePath = `uploads/${filename}`;
      } else if (!imagePath && previous.human_verified !== true) {
        await client.query('ROLLBACK');
        return res.status(400).json({ message: 'Please upload the original X-ray before saving the final diagnosis.' });
      }
      const findings = { ...previous, annotations, human_verified: true, xray_image_path: imagePath };
      const result = await client.query(
        `UPDATE ai_diagnostics SET clinical_notes = $1, ai_findings = $2::jsonb
         WHERE diagnosis_id = $3 AND patient_id = $4
         RETURNING diagnosis_id AS id, patient_id, clinical_notes, ai_findings, scan_date`,
        [body.clinical_notes, JSON.stringify(findings), id, patientId],
      );
      await client.query('COMMIT');
      committed = true;
      return res.status(200).json({ message: 'Final diagnosis saved.', diagnostic: result.rows[0] });
    } catch (error) {
      if (client && !committed) await client.query('ROLLBACK').catch(() => {});
      if (uploadedName && !committed) {
        await supabase.storage.from('file-record').remove([uploadedName]).catch(() => {});
      }
      console.error('Final diagnosis save failed:', error.message);
      return res.status(500).json({ message: error.message.startsWith('X-ray storage') || error.message.startsWith('Unable to store')
        ? error.message : 'Unable to save the final diagnosis. Please try again.' });
    } finally {
      if (client) client.release();
    }
  };
}

function registerDiagnosticRecords(app, dependencies) {
  app.put('/api/diagnostic-imaging/:id/final', (req, res, next) => {
    imageUpload(req, res, error => {
      if (error) return res.status(400).json({ message: error.code === 'LIMIT_FILE_SIZE'
        ? 'The X-ray must be 20 MB or smaller.' : 'Unable to read the uploaded X-ray or diagnosis.' });
      next();
    });
  }, createSaveFinalDiagnosis(dependencies));
}

module.exports = { registerDiagnosticRecords, createSaveFinalDiagnosis };
