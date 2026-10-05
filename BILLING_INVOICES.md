# Patient billing PDFs

Saved clinic receipt fields remain in appointments.receipt_details. The patient billing API generates a PDF from those fields and returns invoice_path as an HTTPS URL rather than the receipt object.

Deployment uses the existing SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. The service creates a private billing-invoices bucket on first use; that key must be permitted to create buckets and upload/sign objects. A public bucket with that name is rejected. Links expire after one hour; reload Billings for a fresh link. Files are keyed by patient, appointment and content hash, so edited statements receive a new document. Existing explicit HTTPS invoice links remain compatible.

Storage failures leave billing amounts visible but return invoice_path: null. Inspect Cloud Run invoice-generation errors if a link is unavailable. No database migration or patient test-data insertion is required.

After deployment: save a fictional test bill through clinic Billing, open the same patient's mobile Billings, verify partial balance and open its PDF. Verify another patient's account cannot read this billing API. Local regression tests mock storage; production credentials and bucket permissions still require this smoke test.
