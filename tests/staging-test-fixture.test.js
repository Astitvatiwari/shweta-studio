import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import artworks from '../artworks.js';
import {
  STAGING_TEST_FIXTURE,
  STAGING_TEST_DATABASE_NAME,
  assertStagingTestDatabaseIsEmpty,
  filterPublicInventory,
  getRuntimeCatalog,
  resolveStagingTestFixtureConfig,
  verifyStagingTestDatabaseIdentity,
  validateStagingTestFixtureCart
} from '../data/staging-test-fixture.js';

const identity = '0123456789abcdef0123456789abcdef';
const fixtureEnv = overrides => ({
  NODE_ENV: 'production',
  STORAGE_BACKEND: 'postgres',
  SHWETA_RUNTIME_MODE: 'staging-fixture',
  SHWETA_STAGING_TEST_FIXTURE: 'enabled',
  RAZORPAY_KEY_ID: 'rzp_test_fixture123',
  RAZORPAY_KEY_SECRET: 'test_secret_only',
  RAZORPAY_WEBHOOK_SECRET: 'test_webhook_only',
  STAGING_TEST_NETLIFY_PROXY_SIGNING_SECRET: 'synthetic-test-site-proxy-secret-0123456789',
  STAGING_TEST_NETLIFY_SITE_URL: 'https://shweta-studio-fixture-test.netlify.app',
  STAGING_TEST_DATABASE_URL: `postgres://fixture:fixture@127.0.0.1:5432/${STAGING_TEST_DATABASE_NAME}`,
  STAGING_TEST_DATABASE_HOST: '127.0.0.1',
  STAGING_TEST_DATABASE_NAME,
  STAGING_TEST_DATABASE_USER: 'fixture',
  STAGING_TEST_DATABASE_IDENTITY: identity,
  ...overrides
});

const enabledConfig = resolveStagingTestFixtureConfig(fixtureEnv());
assert.equal(enabledConfig.enabled, true);
assert.equal(enabledConfig.databaseName, STAGING_TEST_DATABASE_NAME);
assert.deepEqual(getRuntimeCatalog(artworks, enabledConfig), [STAGING_TEST_FIXTURE],
  'the isolated fixture backend uses a fixture-only catalog');
assert.ok(!artworks.some(item => item.inventoryCode === STAGING_TEST_FIXTURE.inventoryCode),
  'the synthetic SKU is not added to artworks.js');
const artworksSource = await fs.readFile(new URL('../artworks.js', import.meta.url), 'utf8');
const compilerSource = await fs.readFile(new URL('../compile.js', import.meta.url), 'utf8');
assert.ok(!artworksSource.includes(STAGING_TEST_FIXTURE.inventoryCode));
assert.ok(!compilerSource.includes(STAGING_TEST_FIXTURE.inventoryCode));
assert.ok(!getRuntimeCatalog(artworks, resolveStagingTestFixtureConfig({ NODE_ENV: 'production' }))
  .some(item => item.inventoryCode === STAGING_TEST_FIXTURE.inventoryCode),
'production/default catalog never includes the synthetic SKU');
assert.deepEqual(filterPublicInventory({
  [STAGING_TEST_FIXTURE.inventoryCode]: STAGING_TEST_FIXTURE,
  'SS-PT-018': { inventoryCode: 'SS-PT-018', status: 'Available' }
}), { 'SS-PT-018': { inventoryCode: 'SS-PT-018', status: 'Available' } },
'public inventory output hides the fixture');

const eligibleFixtureLine = { inventoryCode: STAGING_TEST_FIXTURE.inventoryCode, purchaseType: 'original', quantity: 1 };
assert.equal(validateStagingTestFixtureCart([eligibleFixtureLine], true), null,
  'only the gated one-unit original fixture checkout is eligible');
for (const invalidFixtureCart of [
  { items: [eligibleFixtureLine], enabled: false },
  { items: [{ ...eligibleFixtureLine, purchaseType: 'commission' }], enabled: true },
  { items: [{ ...eligibleFixtureLine, quantity: 2 }], enabled: true },
  { items: [eligibleFixtureLine, eligibleFixtureLine], enabled: true }
]) {
  assert.ok(validateStagingTestFixtureCart(invalidFixtureCart.items, invalidFixtureCart.enabled),
    'disabled, commissioned, multi-quantity, and duplicate fixture orders are rejected');
}

assert.equal(resolveStagingTestFixtureConfig({ NODE_ENV: 'production' }).enabled, false,
  'normal production config leaves the fixture disabled');
for (const [name, env] of [
  ['only one gate', fixtureEnv({ SHWETA_STAGING_TEST_FIXTURE: undefined })],
  ['live key', fixtureEnv({ RAZORPAY_KEY_ID: 'rzp_live_fixture123' })],
  ['missing API secret', fixtureEnv({ RAZORPAY_KEY_SECRET: '' })],
  ['missing webhook secret', fixtureEnv({ RAZORPAY_WEBHOOK_SECRET: '' })],
  ['non-PostgreSQL storage', fixtureEnv({ STORAGE_BACKEND: 'catalog' })],
  ['normal proxy secret present', fixtureEnv({ NETLIFY_PROXY_SIGNING_SECRET: 'existing-staging-secret' })],
  ['production storefront origin present', fixtureEnv({ STOREFRONT_ORIGINS: 'https://shwetastudio.com' })],
  ['missing test-site proxy secret', fixtureEnv({ STAGING_TEST_NETLIFY_PROXY_SIGNING_SECRET: '' })],
  ['production site URL', fixtureEnv({ STAGING_TEST_NETLIFY_SITE_URL: 'https://shwetastudio.com' })],
  ['database URL fallback', fixtureEnv({ STAGING_TEST_DATABASE_URL: undefined, DATABASE_URL: 'postgres://stage/db' })],
  ['normal database URL present', fixtureEnv({ DATABASE_URL: 'postgres://stage/shweta_studio' })],
  ['migration URL present', fixtureEnv({ MIGRATION_DATABASE_URL: 'postgres://stage/shweta_studio' })],
  ['wrong expected name', fixtureEnv({ STAGING_TEST_DATABASE_NAME: 'shweta_studio' })],
  ['wrong URL database', fixtureEnv({ STAGING_TEST_DATABASE_URL: 'postgres://fixture:fixture@127.0.0.1:5432/shweta_studio' })],
  ['wrong database host', fixtureEnv({ STAGING_TEST_DATABASE_HOST: 'staging-db.internal' })],
  ['missing expected database host', fixtureEnv({ STAGING_TEST_DATABASE_HOST: '' })],
  ['wrong database user', fixtureEnv({ STAGING_TEST_DATABASE_USER: 'other' })],
  ['missing identity', fixtureEnv({ STAGING_TEST_DATABASE_IDENTITY: '' })],
  ['production mode requested as fixture', fixtureEnv({ SHWETA_RUNTIME_MODE: 'production' })],
  ['fixture flag without fixture runtime', fixtureEnv({ SHWETA_RUNTIME_MODE: 'production' })]
]) {
  assert.throws(() => resolveStagingTestFixtureConfig(env), /configuration rejected/i, `${name} fails closed`);
}
assert.throws(() => resolveStagingTestFixtureConfig({
  ...fixtureEnv(), STAGING_TEST_DATABASE_URL: 'not-a-postgres-url'
}), /configuration rejected/i, 'invalid database URLs fail closed');

const identityQuery = ({ actualName = STAGING_TEST_DATABASE_NAME, actualUser = 'fixture', markerValue = identity,
  roleOverrides = {},
  otherInventory = 0, otherItems = 0, otherOrders = 0, otherPaymentEvents = 0 } = {}) => async (sql) => {
  if (/current_database/.test(sql)) return { rows: [{ database_name: actualName, database_user: actualUser }], rowCount: 1 };
  if (/FROM pg_roles/.test(sql)) return { rows: [{ role_name: actualUser, rolcanlogin: true, rolsuper: false,
    rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false,
    rolinherit: false, has_role_memberships: false, ...roleOverrides }], rowCount: 1 };
  if (/database_identity/.test(sql)) return { rows: [{ identity_value: markerValue }], rowCount: 1 };
  if (/FROM inventory/.test(sql)) return { rows: [{ count: otherInventory }], rowCount: 1 };
  if (/FROM payment_events/.test(sql)) return { rows: [{ count: otherPaymentEvents }], rowCount: 1 };
  if (/FROM order_items/.test(sql)) return { rows: [{ count: otherItems }], rowCount: 1 };
  if (/FROM orders/.test(sql)) return { rows: [{ count: otherOrders }], rowCount: 1 };
  throw new Error('Unexpected identity query.');
};

assert.equal(await verifyStagingTestDatabaseIdentity(identityQuery(), enabledConfig), true);
await assert.rejects(
  verifyStagingTestDatabaseIdentity(identityQuery({ actualUser: 'staging_app' }), enabledConfig),
  /database identity does not match/i,
  'a different database role is rejected'
);
await assert.rejects(
  verifyStagingTestDatabaseIdentity(identityQuery({ actualName: 'shweta_studio' }), enabledConfig),
  /database identity does not match/i,
  'a staging/production database name is rejected'
);
await assert.rejects(
  verifyStagingTestDatabaseIdentity(identityQuery({ markerValue: 'wrong-marker' }), enabledConfig),
  /identity marker/i,
  'a database without the expected independent marker is rejected'
);
await assert.rejects(
  verifyStagingTestDatabaseIdentity(identityQuery({ roleOverrides: { rolsuper: true } }), enabledConfig),
  /role policy/i,
  'an elevated database role is rejected'
);
await assert.rejects(
  verifyStagingTestDatabaseIdentity(identityQuery({ otherInventory: 1 }), enabledConfig, { requireFixtureOnlyData: true }),
  /non-fixture inventory, orders, or payment events/i,
  'any non-fixture inventory causes startup rejection before expiry cleanup'
);
await assert.rejects(
  verifyStagingTestDatabaseIdentity(identityQuery({ otherPaymentEvents: 1 }), enabledConfig, { requireFixtureOnlyData: true }),
  /non-fixture inventory, orders, or payment events/i,
  'unlinked or unrelated payment audit rows prevent startup'
);

const emptyDatabaseQuery = ({ applicationRelation = false, unexpectedSchema = false,
  markerSchema = false, markerTable = false } = {}) => async (sql) => {
  if (/FROM pg_namespace/.test(sql) && /LIMIT 1/.test(sql)) {
    return { rows: unexpectedSchema ? [{ nspname: 'unrelated_app' }] : [], rowCount: Number(unexpectedSchema) };
  }
  if (/FROM pg_class/.test(sql)) {
    return { rows: applicationRelation ? [{ nspname: 'public', relname: 'orders', relkind: 'r' }] : [],
      rowCount: Number(applicationRelation) };
  }
  if (/to_regclass/.test(sql)) return { rows: [{ marker_table: markerTable ? 'shweta_fixture_meta.database_identity' : null }], rowCount: 1 };
  if (/AS schema_exists/.test(sql)) return { rows: [{ schema_exists: markerSchema }], rowCount: 1 };
  throw new Error('Unexpected empty-database query.');
};
assert.equal(await assertStagingTestDatabaseIsEmpty(emptyDatabaseQuery()), false,
  'a blank database is allowed before marker creation');
await assert.rejects(assertStagingTestDatabaseIsEmpty(emptyDatabaseQuery({ applicationRelation: true })),
  /application tables/i, 'existing application relations prevent initialization');
await assert.rejects(assertStagingTestDatabaseIsEmpty(emptyDatabaseQuery({ unexpectedSchema: true })),
  /unexpected non-system schema/i, 'unexpected schemas prevent initialization');
await assert.rejects(assertStagingTestDatabaseIsEmpty(emptyDatabaseQuery({ markerSchema: true })),
  /incomplete fixture identity schema/i, 'an incomplete identity schema is rejected');

const catalogPreflight = new PGlite();
try {
  assert.equal(await assertStagingTestDatabaseIsEmpty(catalogPreflight.query.bind(catalogPreflight)), false,
    'a real PostgreSQL-compatible empty catalog passes the preflight');
  await catalogPreflight.exec('CREATE TABLE public.orders (order_id text PRIMARY KEY)');
  await assert.rejects(
    assertStagingTestDatabaseIsEmpty(catalogPreflight.query.bind(catalogPreflight)),
    /application tables or other relations/i,
    'a real PostgreSQL-compatible catalog rejects existing application tables'
  );
} finally {
  await catalogPreflight.close();
}

// Exercise checkout and inventory transitions against an in-memory PostgreSQL
// implementation. No hosted database, staging data, or Razorpay endpoint is used.
process.env.DATABASE_URL = 'postgres://local-fixture-test:unused@127.0.0.1:1/local_fixture_test';
const { createPostgresStore } = await import('../data/inventory-postgres-store.js');
const db = new PGlite();
const migration = await fs.readFile(new URL('../db/migrations/001_initial_schema.sql', import.meta.url), 'utf8');
await db.exec(migration);
const store = createPostgresStore({
  query: db.query.bind(db),
  transaction: work => db.transaction(tx => work(tx)),
  catalog: [STAGING_TEST_FIXTURE],
  fixtureConfig: { enabled: false }
});

try {
  const inventory = await store.getInventory();
  assert.deepEqual(Object.keys(inventory), [STAGING_TEST_FIXTURE.inventoryCode],
    'fixture test store seeds no real artwork rows');
  const customer = {
    name: 'Synthetic Staging Test',
    email: 'staging-fixture@example.invalid',
    country: 'India',
    address: 'Synthetic test address',
    city: 'Agra',
    state: 'Uttar Pradesh',
    postalCode: '000000'
  };

  const failedOrder = await store.createCartOrder({
    customer,
    items: [{ inventoryCode: STAGING_TEST_FIXTURE.inventoryCode, purchaseType: 'original', quantity: 1 }],
    clientRequestId: 'stage-fixture-failure'
  });
  assert.equal(failedOrder.success, true, 'fixture SKU is eligible only in the isolated fixture store');
  assert.equal(failedOrder.order.currency, 'INR');
  assert.equal(failedOrder.order.subtotalNumeric, 100);
  let row = await store.getArtworkInventory(STAGING_TEST_FIXTURE.inventoryCode);
  assert.equal(row.status, 'Reserved');
  assert.equal(row.originalQuantity, 0);
  assert.equal(row.reservationType, 'checkout_hold');

  const failed = await store.updateOrderPaymentStatus(failedOrder.order.orderId, { paymentStatus: 'failed' });
  assert.equal(failed.success, true);
  row = await store.getArtworkInventory(STAGING_TEST_FIXTURE.inventoryCode);
  assert.equal(row.status, 'Available');
  assert.equal(row.originalQuantity, 1);

  const expiryOrder = await store.createCartOrder({
    customer,
    items: [{ inventoryCode: STAGING_TEST_FIXTURE.inventoryCode, purchaseType: 'original', quantity: 1 }],
    clientRequestId: 'stage-fixture-expiry'
  });
  assert.equal(expiryOrder.success, true);
  await db.query(`UPDATE inventory SET reserved_until=now()-interval '1 second'
    WHERE inventory_code=$1 AND reserved_order_id=$2`, [STAGING_TEST_FIXTURE.inventoryCode, expiryOrder.order.orderId]);
  row = await store.getArtworkInventory(STAGING_TEST_FIXTURE.inventoryCode);
  assert.equal(row.status, 'Available');
  assert.equal(row.originalQuantity, 1);
  const expiredOrder = await db.query('SELECT payment_status FROM orders WHERE order_id=$1', [expiryOrder.order.orderId]);
  assert.equal(expiredOrder.rows[0].payment_status, 'expired');

  const capturedOrder = await store.createCartOrder({
    customer,
    items: [{ inventoryCode: STAGING_TEST_FIXTURE.inventoryCode, purchaseType: 'original', quantity: 1 }],
    clientRequestId: 'stage-fixture-capture'
  });
  assert.equal(capturedOrder.success, true);
  await store.updateRazorpayOrderId(capturedOrder.order.orderId, 'order_fixture_100');
  const captured = await store.updateOrderPaymentStatus(capturedOrder.order.orderId, {
    paymentStatus: 'confirmed', razorpayPaymentId: 'pay_fixture_100',
    eventId: 'evt_fixture_100', eventType: 'payment.captured'
  });
  assert.equal(captured.success, true);
  row = await store.getArtworkInventory(STAGING_TEST_FIXTURE.inventoryCode);
  assert.equal(row.status, 'Sold');
  assert.equal(row.originalQuantity, 0);
  const replay = await store.updateOrderPaymentStatus(capturedOrder.order.orderId, {
    paymentStatus: 'confirmed', razorpayPaymentId: 'pay_fixture_100',
    eventId: 'evt_fixture_100', eventType: 'payment.captured'
  });
  assert.equal(replay.success, true);
  const events = await db.query('SELECT count(*)::int AS count FROM payment_events WHERE order_id=$1', [capturedOrder.order.orderId]);
  assert.equal(events.rows[0].count, 1, 'duplicate event keeps one audit record');
  console.log('Staging synthetic checkout fixture isolation tests passed.');
} finally {
  await db.close();
}
