# Isolated API packaging and two-role fixture

This is an undeployed candidate. Do not apply render.yaml (paid resources).

Build: `docker build -t shweta-runtime .`. The image uses Node 24.22.1,
Debian bookworm and libpq 18.6. It compiles the locked native addon, checks
Pool/Client loading and linkage, and runs as `node`. CMD starts the API;
it never migrates. PORT is supplied by the host. /healthz remains liveness;
fixture identity and privilege verification precede listening. SIGTERM drains
HTTP and closes the shared pool with a 15-second failure deadline.

Provisioning, performed separately only after approval, must create a NEW empty
shweta_studio_checkout_test database owned by a provisioning identity. Neither
operational role owns the database. Revoke PUBLIC database CREATE/TEMP/CONNECT;
grant CONNECT to two distinct NOINHERIT logins with no memberships or elevated
role attributes. Set their database-local search_path to public. Revoke PUBLIC
schema CREATE; transfer public schema ownership to the migration role and grant
USAGE to the app. Provisioner owns shweta_fixture_meta.database_identity and its
immutable checkout_fixture_database marker; both operational roles get only
schema USAGE and marker SELECT. Do not clone customer or artwork data.

For the migration role's future objects in public, default privileges grant
app SELECT/INSERT/UPDATE on tables and USAGE/SELECT on sequences; no DELETE,
TRUNCATE, REFERENCES or TRIGGER. Migration tracking is explicitly reduced to
SELECT for app by db-migrate. Migration ownership includes DDL on public only.
No operational role receives database CREATE or TEMP. Review every future
migration's grants; tables outside this schema receive no default grant.

Configuration: existing isolated fixture gates and STAGING_TEST_DATABASE_* names
remain. Add STAGING_TEST_ROLE_MODE=separate and STAGING_TEST_MIGRATION_USER.
Only migration processes receive STAGING_TEST_MIGRATION_URL. The application
URL and migration URL must match the exact approved hostname, port and database
and have different configured users. Both processes use the same immutable
identity marker. Run initialize-staging-test-db.js to verify provisioning, then
run db-migrate.js separately. Remove migration URL before launching the API.
Runtime starts with the app credential only; the migration username is not a
credential. In Neon mode both URL paths retain native TLS and channel binding
requirements. The legacy single-role JS fixture remains for compatibility;
Neon fixture mode requires separation and never falls back to it.

Actual Neon access and Render deployment are NOT part of these tests. CI uses
loopback PostgreSQL and temporary certificates, including a Neon-shaped alias.
Never copy that alias or CA into a hosted configuration. Native system trust,
mandatory channel binding and verify-full remain enabled.

Orders, reservations and webhook event state reside in PostgreSQL. Retries are
handled by existing verified payment paths; this change does not add an external
reconciliation worker. A delayed captured payment after cancellation/expiry
requires separate operational review. Render Free sleep can exceed Razorpay's
webhook deadline. Test retry recovery and ambiguous payments before live use.
The image and RSS measurements are CI evidence only, not Render compatibility.
Do not use filesystem persistence, migrate on startup, or add keepalive traffic
as a substitute for an availability plan. Export and restore-test independent
backups before retaining any hosted data. Keep credentials outside Git/images.

Next approval: exact new Free Render service and empty Neon project, reviewed
provisioning SQL, separate credentials and spend controls. Then database-only
TLS/identity/permissions/startup checks; Test Mode checkout requires its own
approval. No real payment or deployment is authorized by this document.
