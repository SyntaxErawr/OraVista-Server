Patient diagnostic X-rays
========================

No database migration is required. The existing PostgreSQL `ai_diagnostics.ai_findings`
JSON field now includes `xray_image_path` together with `annotations` and
`human_verified`. Example path: `uploads/record_diagnostic_123_<uuid>.png`.

Deploy the updated Node server and React frontend together (or deploy the server
first). The frontend still uses FastAPI to analyze uploads, but saves final
diagnoses through `PUT /api/diagnostic-imaging/:id/final` on the Node server.
This writes to the same `ai_diagnostics` table used by FastAPI. No change to the
FastAPI source is needed for this flow.

The Node server needs its existing `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` settings, and the existing `file-record` storage
bucket must accept PNG/JPEG uploads up to 20 MB. It uses the existing public
`/uploads` redirect for these stored files. Browser access to the bucket must
allow cross-origin image reads so the annotated image can be composed for PDF
export. Do not put the service role key in the frontend.

New final saves store the original uploaded image, final annotations, and notes.
Later edits retain the same image reference. Records and PDF export reconstruct
boxes and labels from saved `annotations`, never from the original predictions.
The PDF preserves image proportions and puts large images on another page.
If a referenced image cannot load, export fails with an error instead of silently
producing an incomplete report.

Older diagnoses without `xray_image_path` continue to show their findings and
notes; records and PDFs explicitly state that their original image is unavailable.
The original image cannot be recovered from annotation coordinates. Uploading
and analyzing that image again creates a new diagnosis with persistent image
storage; old diagnoses are not paired with unrelated patient uploads.

Validation:

    node --test diagnosticRecords.test.js

Live smoke check after deployment: select a patient, upload a PNG/JPEG X-ray,
retain/remove/add findings, enter notes, and save. Reload the dentist page and
verify the original image and saved annotations return. Sign in as that patient,
verify the annotated image and notes in Records, then download the PDF and check
that the same boxes/labels appear. Repeat with an empty final annotation list;
removed predictions must not reappear. Existing diagnoses without images should
still export their text with an explicit image-unavailable message.
