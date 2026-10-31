# Staging verification checklist

## Phase 4 — staging deployment and storefront smoke test (complete)

- The Netlify staging website is published, and the Render staging API is live. The owner reports that `/healthz` passes.
- The owner confirms both Render and Netlify staging deployments use feature-branch commit `f55a788`.
- The owner manually verified that artworks `SS-PT-013` and `SS-PT-014` appear in the shopping bag with the correct images and prices.
- The feature branch `fix/cart-inventory-verification` configures both the default `netlify.toml` and `netlify.staging.toml` to proxy `/api/*` only to `https://shweta-studio-staging-api.onrender.com`, with signed proxying. The production `main` branch and production site were not changed.
- These checks do not establish successful Razorpay payment or webhook processing. Live payments have not been enabled.

## Phase 5 — Razorpay sandbox checkout and payment verification (pending)

Use synthetic customer/order data and Razorpay test credentials only. Do not use live keys or enable live transactions.

- [x] Successful Razorpay Test Mode purchase for `SS-PT-009` verified by the owner in staging PostgreSQL using pgAdmin and a read-only query: `payment_status=confirmed`, gateway order/payment links present, inventory `Sold`, `original_quantity=0`. No customer data or raw payment identifiers were recorded here.
- [x] Failed Razorpay Test Mode payment for `SS-PT-013` verified by the owner in staging PostgreSQL: `payment_status=failed`, inventory `Available`, `original_quantity=1`.
- [x] Cancelled Razorpay Test Mode checkout for `SS-PT-014` verified by the owner in staging PostgreSQL: `payment_status=cancelled`, inventory `Available`, `original_quantity=1`.
- [x] Automated PostgreSQL concurrency and expiry checks in Actions run #19 verified one winning reservation, same-request idempotency, expiry release, and protection from a late capture taking a replacement reservation.
- [x] A synthetic webhook with an invalid signature was rejected by the staging API with HTTP 400. `SS-PT-013` inventory remained `Available`, quantity `1`, before and after. The signature check returns before order-store lookup or payment-state update; no order/customer data was queried.
- [x] PostgreSQL-backed automated idempotency test in Actions run #19 used a dedicated random test schema and two concurrent confirmations with the same payment/event IDs. It asserted one `payment_events` row and one sold transition. This verifies store-level replay idempotency, not a live Razorpay delivery replay or webhook signature.
- [ ] Live Razorpay Test Mode webhook replay remains unverified: the payment detail has no delivery record/replay option, and no original signed delivery payload is available. No signature was reconstructed and no order/payment record was changed for this check.
- [x] Synthetic signed amount and currency mismatch cases both returned HTTP 400 in GitHub Actions run #19. These were automated tests, not a live staging webhook.
- [ ] Repeat amount/currency mismatch verification with a valid staging webhook signature and confirm no order/inventory state change. Not run in staging; the webhook secret remains only in Render.
- [x] Unauthenticated `GET /api/orders` through the Netlify staging proxy returned HTTP 403 without returning order data.
- [x] GitHub Actions run #19 at `f55a788` passed `npm run test:all` with PostgreSQL 16, including multi-connection concurrency/expiry tests, and the Playwright Chromium regression suite for payment-confirmation states.
- [ ] Finish valid signed webhook replay and signed mismatch checks before marking Phase 5 complete. No production launch or live-payment activation is authorized by this checklist.

## Staging configuration and safety notes

- Render staging API: `shweta-studio-staging-api`; use only the staging PostgreSQL database and Singapore internal database URL. Keep TLS enabled; the narrowly scoped internal Render certificate handling is documented in `docs/backend-deployment.md`.
- Render secrets belong only in Render. Keep the matching `NETLIFY_PROXY_SIGNING_SECRET` in the staging Netlify site's runtime environment; do not put database, admin, or Razorpay secrets in the frontend.
- The staging Netlify site must deploy `fix/cart-inventory-verification`. Both Netlify config files on this branch target the staging API; `main` retains the production configuration.
- Use Free staging resources only. Stop if a dashboard requires a paid plan or shows a charge. Free Render Postgres is temporary and has no backups; do not use it for production data.
- No production settings, merge, production deployment, or live-payment activation are part of Phase 4 or this Phase 5 handoff.
