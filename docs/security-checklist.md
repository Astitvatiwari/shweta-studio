# Security review checklist

Status reflects repository code and tests in this workspace. “Passed” means the stated check ran locally; it does not certify a hosted deployment.

| Area | Status | Evidence / remaining action |
| --- | --- | --- |
| Secret handling | Passed in code review | Razorpay and database credentials are server environment variables. Production API responses and logs avoid database URLs, SQL, and stack traces. Keep actual values out of Netlify client variables and Git. |
| PostgreSQL access | Passed in code; Requires Configuration | Parameterized SQL and transactional inventory updates are implemented. TLS remains enabled; only Render's bare private `dpg-…` database hostnames skip verification of Render's self-signed certificate. External hosts retain certificate verification; URL parameters cannot override the policy. Configure private access, a runtime role limited to table DML, and a separate migration URL. |
| Inventory concurrency | Requires Configuration | Row locks and transactional reservations are implemented. Run `npm run test:db-concurrency` with a disposable, isolated `TEST_DATABASE_URL` against real PostgreSQL before staging sign-off. PGlite tests do not prove multi-connection locking. |
| Razorpay verification | Passed in code/tests | HMAC signatures use timing-safe comparison; checkout prices come from the server; webhook amount/currency/order matching, event idempotency, and duplicate payment IDs are enforced. Late captures are acknowledged and flagged for studio reconciliation. Only test credentials are permitted for staging. |
| Admin authorization | Passed in code/tests | Existing order export requires a timing-safe `ADMIN_API_KEY`; Netlify proxy signing is not accepted as admin authorization. Configure a high-entropy key and restrict its access. |
| Customer accounts/passwords/sessions | Not Applicable | No customer login, password storage, or session-based account feature exists; do not add one for this storefront. |
| Customer order isolation | Passed in code review | Public checkout/payment responses omit full customer records; order listing is admin-only. Confirm response shapes again during staging browser/API testing. |
| Inputs and price manipulation | Passed in code/tests | Request size, field lengths, quantities, item counts, types, identifiers, and JSON content types are validated. SQL uses parameters and prices are recalculated server-side. |
| XSS and uploads | Passed in code review / Not Applicable | Dynamic cart and checkout content is escaped and image sources are constrained. No customer upload endpoint exists. Recheck generated pages and browser behavior when Chromium is available. |
| CSRF and CORS | Passed in code/tests | State-changing API requests require JSON, browser origins are allow-listed, and production API access requires a short-lived signed Netlify proxy token. Webhooks use their own Razorpay signature. |
| Rate limiting | Requires Configuration | Application rate limiting is per observed backend/proxy IP. Configure Netlify edge or equivalent per-visitor limits for login-free sensitive endpoints and webhook abuse controls. |
| HTTPS and headers | Passed in configuration; Requires Configuration | HSTS and security headers are configured. Verify certificates, redirects, and HTTPS-only custom domains on staging. |
| Static-site CSP | Requires Review | Current policy blocks plugins, constrains the base URL, and limits framing, but does not yet define a complete script/style/connect source allow-list. The site has inline handlers and third-party payment/analytics/email assets; validate an allow-list in browser staging before enforcing a stricter policy. |
| Static/source exposure | Passed in code/config tests | Production API does not serve repository files; Netlify blocks data, source, tests, docs, and environment-file paths. |
| JSON data and Git history | Passed for available history | The current inventory JSON contains 38 artwork records and no personal-data-like keys; the tracked orders JSON is empty. Both files have two reachable historical revisions. A pattern scan of 56 source/config/data blobs found only regression-test fixture secret strings; no credential values were displayed. This scan is not a general secret-scanner certification. |
| Database backups | Requires Configuration | No backup job or storage service was created. Configure automated daily offsite backups, alerting, retention, and a tested restore procedure for the selected database plan. |
| Debug mode and errors | Passed in code/tests | Production errors are generic; health endpoint is minimal; production API mode is explicit. Validate hosted logs and disable any provider debug settings. |
| Dependencies | Passed locally | `npm audit` reported zero known vulnerabilities for installed dependencies on 2026-10-30. Re-run in CI and before deployment. |
| CI database and Chromium browser regression | Passed in CI; staging Requires Configuration | GitHub Actions staging regression #9 passed on commit `201dfb8`, including PostgreSQL 16 concurrency/expiry checks and Playwright Chromium cart, thumbnail, cancellation, and demo-checkout checks. Razorpay-backed staging tests still require isolated staging services and test credentials. |

## Local evidence

- `npm test`: 31/31 inventory and API regression checks passed.
- `npm run test:db-schema`: migration constraints and PostgreSQL adapter tests passed on PGlite, including reservations, idempotency, payment replay, release, and late-capture protection.
- `npm run test:security`: production-mode API authorization, file exposure, CORS, content type, headers, and safe database-error checks passed.
- `npm run test:db-concurrency`: skipped because no isolated PostgreSQL test URL or local PostgreSQL server is available. The test now covers concurrent reservation, same-request duplicate checkout, concurrent payment replay, expiry, and replacement-hold protection when run against real PostgreSQL.
- Browser regression: passed in GitHub Actions staging regression #9 on commit `201dfb8`; Chromium cart, thumbnail, cancellation, and demo-checkout checks completed. Staging-hosted browser/payment checks remain pending.
- `npm audit`: zero known vulnerabilities reported at the time of review.
