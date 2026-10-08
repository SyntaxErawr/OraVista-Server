# Transaction and audit modules

Deploy the backend before the matching frontend. New admin routes are `/admin/transactions` and `/admin/audit-logs`; both require an administrator session, including at the API boundary.

## Database setup

The backend runs `migrations/20261008_transaction_audit.sql` before accepting traffic. The database connection must have permission to create tables, functions, indexes and triggers on the existing application tables. If startup reports a migration-permission error, apply that SQL file through your database administration console with the appropriate owner, then restart the backend with those objects accessible to its database role. Repeated initialization is supported.

The migration creates `payment_events` and `audit_events`, enables row-level security, and installs triggers rejecting UPDATE, DELETE and TRUNCATE on the history tables. The application's database owner can access these tables; unprivileged Supabase clients have no public RLS policy. Administrators with database DDL privileges can still change schema protections, so manage those credentials outside normal clinic accounts.

Audit triggers are installed on existing `users`, `appointments`, `patient_records` and `ai_diagnostics` tables. Mutations and their audit insert succeed or fail together. Raw passwords, tokens and clinical payloads are excluded. Authentication requests also record success/failure outcomes. Identity comes from server-verified sessions. A write performed outside this server is recorded as System/unidentified unless that caller provides trusted database session context.

## Staff payment workflow

The existing Paid input remains a cumulative amount. Raising it records the difference as a new payment event, with the current server time and authenticated collector. Choose Cash or E-wallet; e-wallet collection requires a reference. Approval without a new payment does not create a collection event.

Row locking and expected-paid checks prevent stale forms from overwriting concurrent collections. An unchanged amount creates no duplicate payment event. New payments and bill changes commit together. Recorded payments cannot be reduced by editing the amount; this first version deliberately rejects retroactive payment reductions and denying a bill containing payments. Refund/reversal processing is not provided by this version.

Existing appointment billing records are retained. Prior cumulative payments are used as the baseline, but no historical collection events, dates or collectors are fabricated. The Transactions page explains this limit. Historical invoices and balances remain in the existing billing workflow.

## Reporting

Transactions and audit logs support search, Philippine-time date ranges, branch filters, twenty-row pagination, details, refresh and CSV export of all filtered results. Transaction totals reflect the complete selected range, not only the visible page. CSV timestamps are exported in UTC ISO format; page timestamps are displayed in Philippine time.

The dashboard's daily branch earnings now use today's recorded payment events, not unpaid appointment charges. Historical legacy payments are therefore excluded from these totals. This is an intentional change in the financial definition.

## Verification

Server: `npm test` after installing declared dependencies. Web: targeted tests in `I_AdminOversightPage.test.js` and `H_StaffBillingsPage.test.js`, followed by `npm run build`.

Optional isolated PostgreSQL verification: install `@electric-sql/pglite` in a test tools directory, set `NODE_PATH` to its `node_modules`, and run `node tests/oversight-postgres.cjs`. It verifies actual migration SQL, repeat initialization, actor attribution, redaction, immutable history, deletion capture and rollback. It never uses production credentials.

Production deployment and migration execution are not performed by the local implementation checks.
