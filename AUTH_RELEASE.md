# Authentication release and test notes

This release must be deployed with the matching mobile and web changes. Existing cached sessions are no longer valid; sign in again. Older clients cannot complete patient sign-in after this release.

## Server behavior

- Patient login validates the password before emailing a code. Only an opaque challenge ID is returned.
- Verification codes expire after five minutes and are single use. Resend has a 30-second cooldown. Five failed password/code attempts temporarily lock verification for 15 minutes.
- Recovery requires a verified, purpose-bound token valid for ten minutes. Password changes invalidate previous sessions.
- Clinic sign-in remains password based, with a real seven-day session token. Patients also receive seven-day sessions after verification.
- Protected API routes require a Bearer session. Patient IDs in request bodies do not establish ownership. Appointment and billing business rules are preserved.
- Startup creates one additive `auth_state` table and enables row-level security without public policies. Use the existing database owner connection. The app does not start if this initialization fails. No existing table is removed or recreated.
- State is keyed by account ID, persists across restarts, and uses PostgreSQL transaction locks to serialize attempts per account. Tokens are stored as SHA-256 hashes and codes as bcrypt hashes.
- Existing bcrypt accounts continue working. Legacy plaintext seed passwords are no longer accepted: use verified email recovery to set a hashed password for those test accounts.
- Email must be configured using EMAIL_USER and EMAIL_PASS. There is no local OTP bypass or logging of verification secrets.
- GET /api/auth-health returns the authentication version after initialization, for deployment checks. It exposes no account data.

## Verification

Run `npm ci` and `npm test`. Tests use fake accounts, database and mail, and include actual Express/CORS HTTP requests and bcrypt. They do not contact the production database or send real email. Transaction tests check the SQL commit/rollback contract; they do not prove live database behavior or concurrency.

Before recording documentation, run an Android device/emulator smoke test with a dedicated test account: sign in and receive email, incorrect/correct code, recovery, change password, profile upload, booking, cancellation, reschedule request and records/PDF sharing. Check the web clinic can still approve requests. These checks and actual device performance measurements remain separate from the automated pass rate.

The separate AI service and public file-storage permissions are outside this authentication change. This is not a full security audit or a guarantee of zero defects.
