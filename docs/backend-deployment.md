# Backend and database setup

The storefront remains a static Netlify site. The Node.js API and managed PostgreSQL database are configured separately on Render. These repository files do not create services. Applying `render.yaml` provisions billable Render resources, so do that only after approval.

## Staging configuration

1. Create a Render PostgreSQL database and Node web service in the same region. Keep the database private. Use a restricted runtime role for `DATABASE_URL` and the owner/migration connection only for `MIGRATION_DATABASE_URL`.
2. Set `ADMIN_API_KEY` to a randomly generated secret. Set the same high-entropy `NETLIFY_PROXY_SIGNING_SECRET` in Netlify and Render. Set `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, and `RAZORPAY_WEBHOOK_SECRET` to Razorpay **test-mode** values only. Keep `ALLOW_DEMO_CHECKOUT=false` when exercising Razorpay sandbox checkout.
3. Configure the backend custom domain `api.shwetastudio.com`, then set the Razorpay test webhook URL to `https://api.shwetastudio.com/api/payment/webhook` after staging is available.
4. Configure the Netlify site environment separately. Set `NETLIFY_PROXY_SIGNING_SECRET` with Runtime scope and add the deployed site origin to `STOREFRONT_ORIGINS`. `netlify.toml` signs and proxies `/api/*` through the custom API domain; DNS and service-domain activation are external setup steps. Razorpay webhooks bypass that proxy signature and must pass the independent Razorpay HMAC check.
5. Render runs `npm run db:migrate` before starting the service. Migrations are transactional and recorded in `schema_migrations`. The API explicitly selects PostgreSQL with `STORAGE_BACKEND=postgres`; production refuses to start if that mode or its database URL is missing. Netlify builds set `STORAGE_BACKEND=catalog` and compile from public `artworks.js` only; JSON files remain a development/test adapter only.

The schema stores order/customer documents as JSONB to preserve current response shapes, with indexed idempotency/payment identifiers, item rows, and payment event IDs. Inventory rows expose the reservation fields used by transactional `SELECT ... FOR UPDATE` operations.

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Yes | Managed PostgreSQL connection string; keep private. |
| `MIGRATION_DATABASE_URL` | Yes for hosted migration command | DDL-capable managed PostgreSQL URL, separate from the runtime role. |
| `PGSSLMODE` | Yes on hosted database | `require` keeps TLS enabled. Certificate validation is relaxed only for Render's bare private `dpg-…` PostgreSQL hostnames because Render presents a self-signed certificate there; external hostnames retain normal certificate verification. `disable` is rejected in production. URL TLS parameters are normalized so they cannot override this policy. |
| `PORT` | Supplied by Render | HTTP listener port. |
| `NODE_ENV` | Yes | Use `production` on the hosted API. |
| `CHECKOUT_RESERVATION_TTL_MS` | No | Checkout hold duration; defaults to 900000 ms. |
| `API_RATE_LIMIT_PER_PROXY` | No | Backend request ceiling per observed proxy IP per minute; configure edge-level per-visitor controls separately. |
| `ALLOW_DEMO_CHECKOUT` | No | Keep `false` in staging when validating Razorpay test checkout and in production. |
| `ADMIN_API_KEY` | Yes | Protects the existing administrative orders endpoint. |
| `NETLIFY_PROXY_SIGNING_SECRET` | Yes | Shared secret for Netlify's signed proxy and backend JWS verification. |
| `STOREFRONT_ORIGINS` | Yes | Comma-separated exact browser origins permitted by CORS. |
| `NETLIFY_SITE_URL` | No | Optional expected `site_url` claim for proxy-signature validation. |
| `RAZORPAY_KEY_ID` | For sandbox checkout | Razorpay test key ID. |
| `RAZORPAY_KEY_SECRET` | For sandbox checkout | Server-side payment signature and order secret. |
| `RAZORPAY_WEBHOOK_SECRET` | For webhook tests | Secret configured on the Razorpay test webhook. |

Do not place secrets in Netlify client variables or commit them. Netlify needs no database or Razorpay secret; its API rule is a same-origin proxy. Do not use local JSON files as the deployed transaction store.

## Migrations and rollback

Migrations are append-only and run in lexical order. `001_initial_schema.sql` is applied in a transaction; its filename is recorded only after successful DDL. Add a new numbered migration for future schema changes rather than editing an already-applied migration.

The destructive rollback is in `db/rollback/001_initial_schema.down.sql`. Before rollback, stop checkout traffic, make and verify a database backup, export orders and payment-event data, and confirm a restore has been tested. Run the down SQL manually only against the intended database; it drops inventory, orders, order items, and payment events. Rollback is not automatic and must not replace restoring a backup.

The runtime database role should have only SELECT/INSERT/UPDATE/DELETE grants on application tables and no schema ownership or DDL grants. Keep the migration connection private to the deploy/migration process.

Render documents point-in-time recovery for paid Postgres instances, rather than scheduled daily logical backups. The repository does not create an external backup bucket or backup job. For a daily offsite copy, configure a scheduled `pg_dump` job to private object storage, alert on failures, and run a restore drill before handling real orders. PITR and offsite exports require the selected database plan and any storage service to be configured separately.

Render terminates HTTPS for its service domains and custom domains; Netlify should publish only HTTPS URLs. The API adds HSTS to production responses. Validate HTTPS and certificate behavior on the staging domains before launch.

## Local checks

Run `npm run test:all` for the available route, schema/store, and production-security suites. `npm run test:db-concurrency` uses a disposable schema inside a dedicated database configured by `TEST_DATABASE_URL`; never point it at production. Without that variable it reports a skip. The embedded test does not prove multi-connection locking behavior; the actual PostgreSQL concurrency suite is required before staging is considered verified.

### Disposable Render database for real concurrency tests

No database is created by this repository. To run the multi-connection test without paying for a database:

1. In Render Dashboard choose **New + → PostgreSQL**. Name it `shweta-studio-concurrency-test`, set database name to `shweta_studio_test`, choose the **Free** plan, and choose a region. Do not apply the paid Render blueprint.
2. The free database is temporary: Render documents 1 GB storage, 30-day expiration, and no backups. Use it only for synthetic tests, never for customer orders or production. If your workspace already has a free Render Postgres instance, do not create a second one; Render allows only one active free database per workspace.
3. In the database **Info → Networking** section, restrict external access to the public IPv4 address of the computer running the test as a `/32` CIDR. In **Connect**, copy the **External Database URL**; do not paste it into chat or commit it.
4. In PowerShell in the project directory, set the URL for this terminal session and run the concurrency suite:

   ```powershell
   $env:TEST_DATABASE_URL = "<paste the External Database URL here>"
   $env:PGSSLMODE = "require"
   npm run test:db-concurrency
   ```

   The test refuses database names that do not end in `_test`, creates a random isolated schema, exercises concurrent reservation, duplicate request, payment replay, and expiry behavior, then drops that schema. It does not change the database's other schemas.
5. Clear the terminal variable when finished with `Remove-Item Env:TEST_DATABASE_URL`. Delete the disposable database from Render when the test work is complete.

For any later Render-hosted API staging environment, use the database's **Internal Database URL** only in the backend service, and keep a separate least-privilege runtime role from the migration role. The free test instance must never be promoted to the production database.
