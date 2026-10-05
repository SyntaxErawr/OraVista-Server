const crypto = require('node:crypto');
const { jsPDF } = require('jspdf');
const BUCKET = 'billing-invoices';
const receiptObject = value => {
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return {}; } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
};
const money = value => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
function amounts(record) {
  const details = receiptObject(record.receipt_details);
  const charge = money(record.amount);
  const paid = record.billing_status === 'Paid' ? charge : Math.min(charge, money(details.paid));
  return { charge, paid, balance: Math.round((charge - paid) * 100) / 100 };
}
const isPublished = record => ['Pending', 'Approved', 'Paid'].includes(record.billing_status);
function createPDF(record) {
  const doc = new jsPDF();
  const totals = amounts(record), details = receiptObject(record.receipt_details);
  doc.setFontSize(19);
  doc.text('OraVista - Billing statement', 18, 24);
  doc.setFontSize(11);
  const lines = [
    `Reference: ${record.booking_ref || record.id}`,
    `Patient: ${[record.first_name, record.last_name].filter(Boolean).join(' ') || record.user_id}`,
    `Date: ${String(record.appointment_date instanceof Date ? record.appointment_date.toISOString() : record.appointment_date).slice(0, 10)}`,
    `Service: ${record.service_type || 'Dental treatment'}`,
    `Status: ${record.billing_status === 'Approved' ? 'Pending payment' : record.billing_status}`,
    `Charge: PHP ${totals.charge.toFixed(2)}`,
    `Paid: PHP ${totals.paid.toFixed(2)}`,
    `Balance: PHP ${totals.balance.toFixed(2)}`,
    ...(details.nextVisit ? [`Next visit: ${details.nextVisit}`] : []),
    'For personal records. An unpaid bill is not proof of payment.',
  ];
  let y = 40;
  for (const line of lines) {
    for (const part of doc.splitTextToSize(line, 174)) {
      if (y > 275) { doc.addPage(); y = 22; }
      doc.text(part, 18, y); y += 7;
    }
    y += 4;
  }
  return Buffer.from(doc.output('arraybuffer'));
}
function createInvoiceService(supabase) {
  let ready;
  async function ensureBucket() {
    if (!supabase) throw new Error('Invoice storage is not configured.');
    if (!ready) ready = (async () => {
      let { data, error } = await supabase.storage.getBucket(BUCKET);
      if (error && String(error.status || error.statusCode) !== '404') throw error;
      if (!data) {
        const created = await supabase.storage.createBucket(BUCKET, { public: false });
        if (created.error) {
          const check = await supabase.storage.getBucket(BUCKET);
          if (check.error) throw created.error;
          data = check.data;
        }
      }
      if (data?.public) throw new Error('Invoice bucket must be private.');
    })().catch(error => { ready = null; throw error; });
    return ready;
  }
  return async record => {
    if (!isPublished(record)) return null;
    // Keep explicitly uploaded legacy documents compatible.
    if (typeof record.receipt_details === 'string' && /^https:\/\//i.test(record.receipt_details)) return record.receipt_details;
    await ensureBucket();
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify(record)).digest('hex').slice(0, 24);
    const file = `${record.user_id}/${record.id}-${fingerprint}.pdf`;
    const bucket = supabase.storage.from(BUCKET);
    let signed = await bucket.createSignedUrl(file, 3600);
    if (signed.error) {
      const uploaded = await bucket.upload(file, createPDF(record), { contentType: 'application/pdf', upsert: false });
      if (uploaded.error && String(uploaded.error.statusCode || uploaded.error.status) !== '409') throw uploaded.error;
      signed = await bucket.createSignedUrl(file, 3600);
    }
    if (signed.error) throw signed.error;
    return signed.data.signedUrl;
  };
}
module.exports = { receiptObject, amounts, isPublished, createPDF, createInvoiceService };
