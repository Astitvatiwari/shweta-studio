import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createPostgresPool } from '../data/postgres-pool.js';
import { postgresConnectionOptions } from '../data/postgres-connection.js';
import {
  resolveStagingTestFixtureConfig,
  STAGING_TEST_DATABASE_NAME,
  verifyStagingTestDatabaseIdentity
} from '../data/staging-test-fixture.js';

const { Pool } = pg;
const adminUrl = process.env.TEST_DATABASE_URL;
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

if (!adminUrl) {
  if (process.env.CI === 'true') throw new Error('CI must provide TEST_DATABASE_URL for fixture PostgreSQL integration.');
  console.log('Skipped staging fixture PostgreSQL integration: TEST_DATABASE_URL is not configured.');
  process.exit(0);
}

const adminConnection = new URL(adminUrl);
const nativeAdapterCi = process.env.PG_NATIVE_ADAPTER_CI === 'true';
if (!['localhost', '127.0.0.1', '::1'].includes(adminConnection.hostname) ||
    !adminConnection.pathname.slice(1).endsWith('_test') || process.env.CI !== 'true') {
  throw new Error('Refusing fixture integration: TEST_DATABASE_URL must be loopback-only, end in _test, and run in CI.');
}

const testTlsOptions = connectionString => postgresConnectionOptions(connectionString, { sslMode: 'require', production: true });
const adminPool = new Pool({ ...testTlsOptions(adminUrl), max: 2 });
const roleName = 'shweta_fixture_ci';
const otherDatabaseName = 'shweta_fixture_other_test';
const rolePassword = randomBytes(24).toString('hex');
const identity = randomBytes(24).toString('hex');
const quoteIdentifier = value => `"${value.replaceAll('"', '""')}"`;
const quoteLiteral = value => `'${value.replaceAll("'", "''")}'`;
const fixtureUrl = new URL(adminUrl);
if (nativeAdapterCi) {
  const nativeHost = String(process.env.PG_NATIVE_ADAPTER_HOST || '').toLowerCase();
  if (!nativeHost.endsWith('.neon.tech')) {
    throw new Error('Refusing native fixture integration without the fixed disposable Neon-shaped Docker alias.');
  }
  fixtureUrl.hostname = nativeHost;
  fixtureUrl.searchParams.set('channel_binding', 'require');
}
fixtureUrl.username = roleName;
fixtureUrl.password = rolePassword;
fixtureUrl.pathname = `/${STAGING_TEST_DATABASE_NAME}`;
const fixtureEnv = {
  ...process.env,
  NODE_ENV: 'production',
  STORAGE_BACKEND: 'postgres',
  SHWETA_RUNTIME_MODE: 'staging-fixture',
  SHWETA_STAGING_TEST_FIXTURE: 'enabled',
  RAZORPAY_KEY_ID: 'rzp_test_cifixture',
  RAZORPAY_KEY_SECRET: 'ci_test_secret_only',
  RAZORPAY_WEBHOOK_SECRET: 'ci_test_webhook_only',
  STAGING_TEST_NETLIFY_PROXY_SIGNING_SECRET: `ci-only-${randomBytes(24).toString('hex')}`,
  STAGING_TEST_NETLIFY_SITE_URL: 'https://shweta-studio-fixture-ci.netlify.app',
  STAGING_TEST_DATABASE_URL: fixtureUrl.toString(),
  STAGING_TEST_DATABASE_HOST: fixtureUrl.hostname,
  STAGING_TEST_DATABASE_NAME: STAGING_TEST_DATABASE_NAME,
  STAGING_TEST_DATABASE_USER: roleName,
  STAGING_TEST_DATABASE_IDENTITY: identity,
  PGSSLMODE: 'require'
};
let createdRole = false;
const createdDatabases = new Set();
let fixturePool;

function runNode(script, env = fixtureEnv) {
  const result = spawnSync(process.execPath, [path.join(root, script)], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 30000
  });
  return { status: result.status, output: `${result.stdout || ''}${result.stderr || ''}` };
}

function expectScriptFailure(script, pattern, env = fixtureEnv) {
  const result = runNode(script, env);
  assert.notEqual(result.status, 0, `${script} must fail closed`);
  assert.match(result.output, pattern);
}

try {
  const existingRole = await adminPool.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [roleName]);
  const existingFixtureDb = await adminPool.query('SELECT 1 FROM pg_database WHERE datname=$1', [STAGING_TEST_DATABASE_NAME]);
  const existingOtherDb = await adminPool.query('SELECT 1 FROM pg_database WHERE datname=$1', [otherDatabaseName]);
  if (existingRole.rowCount || existingFixtureDb.rowCount || existingOtherDb.rowCount) {
    throw new Error('Refusing fixture integration: a disposable CI role or database name already exists.');
  }

  await adminPool.query(
    `CREATE ROLE ${quoteIdentifier(roleName)} LOGIN PASSWORD ${quoteLiteral(rolePassword)}
     NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`
  );
  createdRole = true;
  await adminPool.query(`CREATE DATABASE ${quoteIdentifier(STAGING_TEST_DATABASE_NAME)} OWNER ${quoteIdentifier(roleName)}`);
  createdDatabases.add(STAGING_TEST_DATABASE_NAME);
  await adminPool.query(`CREATE DATABASE ${quoteIdentifier(otherDatabaseName)} OWNER postgres`);
  createdDatabases.add(otherDatabaseName);
  await adminPool.query(`REVOKE CONNECT ON DATABASE ${quoteIdentifier(otherDatabaseName)} FROM PUBLIC`);

  const config = resolveStagingTestFixtureConfig(fixtureEnv);
  for (const [label, overrides] of [
    ['wrong host', { STAGING_TEST_DATABASE_HOST: 'different-postgres.internal' }],
    ['wrong database', { STAGING_TEST_DATABASE_URL: fixtureEnv.STAGING_TEST_DATABASE_URL.replace(STAGING_TEST_DATABASE_NAME, 'shweta_studio_test') }],
    ['wrong role', { STAGING_TEST_DATABASE_USER: 'wrong_fixture_role' }]
  ]) {
    assert.throws(
      () => resolveStagingTestFixtureConfig({ ...fixtureEnv, ...overrides }),
      /configuration rejected/i,
      `${label} is rejected before connecting`
    );
  }

  fixturePool = nativeAdapterCi
    ? createPostgresPool(config.databaseUrl, { max: 1 })
    : new Pool({ ...testTlsOptions(config.databaseUrl), max: 1 });
  await assert.rejects(
    verifyStagingTestDatabaseIdentity(fixturePool.query.bind(fixturePool), config),
    /identity could not be independently verified/i,
    'a missing marker prevents runtime verification'
  );

  // Seed representative application records in this disposable database only.
  await fixturePool.query('CREATE TABLE public.inventory (inventory_code text PRIMARY KEY)');
  await fixturePool.query('CREATE TABLE public.orders (order_id text PRIMARY KEY)');
  await fixturePool.query('CREATE TABLE public.payment_events (event_id text PRIMARY KEY)');
  await fixturePool.query("INSERT INTO public.inventory VALUES ('SYNTHETIC_EXISTING')");
  await fixturePool.query("INSERT INTO public.orders VALUES ('SYNTHETIC_EXISTING_ORDER')");
  await fixturePool.query("INSERT INTO public.payment_events VALUES ('SYNTHETIC_EXISTING_EVENT')");
  expectScriptFailure('scripts/initialize-staging-test-db.js', /application tables or other relations/i);
  const unmarked = await fixturePool.query(
    "SELECT to_regclass('shweta_fixture_meta.database_identity') AS marker"
  );
  assert.equal(unmarked.rows[0].marker, null, 'existing application data is rejected before any identity marker is written');
  await fixturePool.query('DROP TABLE public.payment_events, public.orders, public.inventory');

  const initialized = runNode('scripts/initialize-staging-test-db.js');
  assert.equal(initialized.status, 0, initialized.output);
  assert.equal(await verifyStagingTestDatabaseIdentity(fixturePool.query.bind(fixturePool), config), true);

  const roleState = await fixturePool.query(
    `SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolinherit,
            EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid) AS has_memberships
     FROM pg_roles r WHERE r.rolname = current_user`
  );
  assert.deepEqual(roleState.rows[0], {
    rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false,
    rolbypassrls: false, rolinherit: false, has_memberships: false
  }, 'the fixture login is a restricted, non-inheriting role');

  const migration = runNode('scripts/db-migrate.js');
  assert.equal(migration.status, 0, migration.output);
  assert.equal(await verifyStagingTestDatabaseIdentity(fixturePool.query.bind(fixturePool), config, {
    requireFixtureOnlyData: true
  }), true, 'migrated real PostgreSQL fixture database passes runtime identity checks');

  const otherUrl = new URL(fixtureUrl);
  otherUrl.pathname = `/${otherDatabaseName}`;
  const otherPool = nativeAdapterCi
    ? createPostgresPool(otherUrl.toString(), { max: 1, connectionTimeoutMillis: 3000 })
    : new Pool({ ...testTlsOptions(otherUrl.toString()), max: 1, connectionTimeoutMillis: 3000 });
  try {
    await assert.rejects(otherPool.query('SELECT current_database()'),
      /permission denied for database/i,
      'the fixture role cannot connect to another database');
  } finally {
    await otherPool.end();
  }

  // A changed marker is never accepted, even when the database/user are right.
  await fixturePool.query(
    'UPDATE shweta_fixture_meta.database_identity SET identity_value=$1 WHERE identity_key=$2',
    ['wrong-marker', 'checkout_fixture_database']
  );
  await assert.rejects(
    verifyStagingTestDatabaseIdentity(fixturePool.query.bind(fixturePool), config),
    /identity marker/i,
    'a missing or mismatched identity marker prevents runtime verification'
  );
  console.log('Staging fixture PostgreSQL isolation integration tests passed.');
} finally {
  await fixturePool?.end();
  for (const databaseName of createdDatabases) {
    await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`).catch(() => {});
  }
  if (createdRole) await adminPool.query(`DROP ROLE IF EXISTS ${quoteIdentifier(roleName)}`).catch(() => {});
  await adminPool.end();
}
