# Clinic service estimates

`service-catalog.json` contains the mobile rates confirmed against the clinic offer on November 23, 2026. Starting fees and the braces down payment are estimates; the clinic sets final billing charges. The materials and tooth-surface notes are retained in the catalog. No separate consultation booking option was added.

New booking requests use the server catalog regardless of `amount`, `price`, or legacy price fields submitted by the client. Known mobile service aliases resolve to the same clinic service. Quote-only services have a null catalog price and store zero as an unquoted pending estimate; this does not mean the service is free or paid. Existing appointments, approved charges, payments, and invoices are not repriced by this change. Staff billing remains responsible for the final charge.

After changing an approved rate, regenerate both client catalogs and rebuild/deploy the applications:

```text
node scripts/sync-service-catalog.cjs "<web repo>" "<mobile MyApp repo>"
node scripts/sync-service-catalog.cjs "<web repo>" "<mobile MyApp repo>" --check
```

The generated files are bundled snapshots, not a live pricing API. Backend publishing belongs to the Cloud Run owner; mobile changes require an updated app build.
