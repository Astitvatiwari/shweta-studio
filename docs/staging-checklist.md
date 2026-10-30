# Staging verification checklist

## Phase 4 — staging deployment and storefront smoke test (complete)

- The Netlify staging website is published, and the Render staging API is live. The owner reports that `/healthz` passes.
- The owner manually verified that artworks `SS-PT-013` and `SS-PT-014` appear in the shopping bag with the correct images and prices.
- The feature branch `fix/cart-inventory-verification` configures both the default `netlify.toml` and `netlify.staging.toml` to proxy `/api/*` only to `https://shweta-studio-staging-api.onrender.com`, with signed proxying. The production `main` branch and production site were not changed.
- These checks do not establish successful Razorpay payment or webhook processing. Live payments have not been enabled.

## Phase 5 — Razorpay sandbox checkout and payment verification (pending)

Use synthetic customer/order data and Razorpay test credentials only. Do not use live keys or enable live transactions.

- Exercise a successful sandbox checkout; verify server-authoritative amount/order creation, payment signature validation, persisted order, and inventory transition only after verified payment.
- Exercise failed and cancelled payments; confirm reservation handling, clear recovery messaging, and no false paid status or unintended sale.
- Verify reservation expiry and that a reserved/sold artwork cannot be purchased concurrently.
- Send valid and invalid webhook signatures; confirm only verified events are applied.
- Replay the same webhook/payment notification; confirm idempotency and no duplicate charge/order/inventory transition.
- Verify unauthorized order access is denied and responses/logs do not expose secrets or customer data.
- Run the staging browser and PostgreSQL regression suites. Record results and unresolved issues before any production launch planning.

## Staging configuration and safety notes

- Render staging API: `shweta-studio-staging-api`; use only the staging PostgreSQL database and Singapore internal database URL. Keep TLS enabled; the narrowly scoped internal Render certificate handling is documented in `docs/backend-deployment.md`.
- Render secrets belong only in Render. Keep the matching `NETLIFY_PROXY_SIGNING_SECRET` in the staging Netlify site's runtime environment; do not put database, admin, or Razorpay secrets in the frontend.
- The staging Netlify site must deploy `fix/cart-inventory-verification`. Both Netlify config files on this branch target the staging API; `main` retains the production configuration.
- Use Free staging resources only. Stop if a dashboard requires a paid plan or shows a charge. Free Render Postgres is temporary and has no backups; do not use it for production data.
- No production settings, merge, production deployment, or live-payment activation are part of Phase 4 or this Phase 5 handoff.
