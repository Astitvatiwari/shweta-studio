# Isolated staging checkout fixture

This document describes a future disposable payment-test backend. It is not the
configuration for the existing staging API or production. No hosting resource,
secret, database, order, or payment is created by this repository change.

## Isolation design

- Keep `SS-STAGE-TEST-001` only in `data/staging-test-fixture.js`. Do not add it
  to `artworks.js`, `compile.js`, generated pages, or frontend bundles.
- Run it on a separate Render Web Service and separate Netlify test site. Do not
  reconfigure the existing staging service or its locked Netlify site.
- Use a distinct logical PostgreSQL database named
  `shweta_studio_checkout_test`, with a dedicated database user and a persistent
  identity marker. Configure `STAGING_TEST_DATABASE_HOST` independently from
  the URL and require an exact hostname match. The fixture service receives only
  `STAGING_TEST_DATABASE_URL`; it must not receive `DATABASE_URL` or
  `MIGRATION_DATABASE_URL`.
- The initializer checks the actual database name, role, restricted role
  attributes, and application objects before creating the marker in a
  transaction. It rejects existing application relations and incomplete marker
  schemas. Startup independently reads the marker and checks fixture-only
  inventory/orders; any mismatch prevents startup.
- Initial migrations may run only against a blank, marked fixture database.
  Later runs are no-ops only when every migration is already applied; pending
  or unknown migrations fail closed. The migration command never falls back to
  the existing staging or production URL.
- The fixture runtime catalog contains only the synthetic SKU. Normal public
  inventory listing and single-item routes hide it. A test checkout must be
  inserted into the browser cart explicitly; it does not receive a storefront
  artwork card or detail page.
- Use a unique Netlify proxy-signing secret and exact test-site URL. The fixture
  backend rejects the normal staging/production proxy variables. Configure
  Razorpay Test Mode only; the runtime gate requires a `rzp_test_` key ID.

## Required environment for the separate test service

Set these only after the separate backend, Netlify test site, and database have
been approved and provisioned:

| Variable | Purpose |
| --- | --- |
| `NODE_ENV=production` | Run the same production server behavior in this isolated service. |
| `STORAGE_BACKEND=postgres` | Require PostgreSQL persistence. |
| `SHWETA_RUNTIME_MODE=staging-fixture` | Explicitly select the isolated backend mode. |
| `SHWETA_STAGING_TEST_FIXTURE=enabled` | Second explicit fixture gate. |
| `STAGING_TEST_DATABASE_URL` | URL for the disposable database only. |
| `STAGING_TEST_DATABASE_HOST` | Exact expected hostname, checked against the database URL. |
| `STAGING_TEST_DATABASE_NAME=shweta_studio_checkout_test` | Expected database name, checked against both URL and server. |
| `STAGING_TEST_DATABASE_USER` | Expected restricted fixture-only database role, checked against URL and server. |
| `STAGING_TEST_DATABASE_IDENTITY` | Random 32–128 character identity value stored in the database marker. |
| `RAZORPAY_KEY_ID` | Test key ID beginning `rzp_test_`. |
| `RAZORPAY_KEY_SECRET` | Razorpay Test Mode API secret. |
| `RAZORPAY_WEBHOOK_SECRET` | Test webhook signing secret. |
| `STAGING_TEST_NETLIFY_PROXY_SIGNING_SECRET` | Unique proxy secret for the test site; do not reuse either existing site secret. |
| `STAGING_TEST_NETLIFY_SITE_URL` | Exact HTTPS URL of the dedicated `*.netlify.app` test site. |

Do not set `DATABASE_URL`, `MIGRATION_DATABASE_URL`,
`NETLIFY_PROXY_SIGNING_SECRET`, `NETLIFY_SITE_URL`, or `STOREFRONT_ORIGINS` on
this service. The configuration fails closed if any appear. Keep all secret
values in provider secret settings, never in this file or source control.

## Setup and test sequence

1. Obtain approval before creating or changing hosting resources.
2. Create the logical database `shweta_studio_checkout_test` in the staging
   PostgreSQL instance (or a separately approved disposable instance) and a
   non-inheriting login role that owns only this database. The role must not
   have superuser, role-creation, database-creation, replication, RLS-bypass,
   or membership privileges. It needs schema/migration rights only within this
   disposable database. The existing application database and user must not be
   used.
3. Set the environment above on the separate fixture API and test Netlify site.
   Confirm no generic database/proxy URLs are present.
4. Run `node scripts/initialize-staging-test-db.js` once. It refuses host,
   database, role, role-privilege, schema, table, or marker mismatches. It will
   not mark a database containing existing application objects or overwrite an
   existing marker.
5. Run `npm run db:migrate` on the fixture service, then start it. Startup checks
   the marker and rejects any non-fixture inventory, order items, or orders.
6. Verify fixture inventory is absent from normal inventory endpoints. Add only
   the synthetic SKU to the test browser cart; server-side pricing remains
   authoritative at ₹100 INR. A successful capture should confirm only this
   fixture; failure/cancellation/expiry should release only this fixture.
7. Before any payment, inspect the prepared order and its expected amount,
   gateway order ID, and reservation expiry. Stop for a separate explicit
   payment-submission approval.

## Retirement and records

- Stop new fixture checkouts by disabling the fixture gates and proxy route.
- Wait for any pending fixture reservation to reach a terminal state or expire;
  never force-release a possibly captured order.
- Keep the fixture SKU, order row, `payment_events`, gateway references, and
  sanitized verification evidence. Do not delete or rewrite payment/audit rows.
- After verifying the database contains fixture-only records, remove the
  temporary API/site configuration under separate approval. Retain the database
  read-only for the agreed audit period; do not drop it as part of cleanup.
- Render Free Postgres is temporary: current documentation says it expires
  after 30 days, has a 1 GB cap, permits one Free instance per workspace, and
  has no managed backups. If the audit record
  must outlive that window, export an encrypted, access-restricted backup before
  expiry or approve a paid durable database. Free Render web services spin down
  after 15 minutes and share a 750-hour monthly workspace allowance. The
  additional web service and Netlify Free site may be $0 within the current
  account limits; confirm dashboard usage before provisioning.
