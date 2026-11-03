import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import { createPostgresPool } from '../data/postgres-pool.js';

const adapterUrl = process.env.PG_NATIVE_ADAPTER_DATABASE_URL;
if (process.env.CI !== 'true' || !adapterUrl || process.env.DATABASE_PROVIDER !== 'neon' ||
    process.env.DATABASE_DRIVER !== 'pg-native') {
  throw new Error('The native adapter integration test requires an explicitly gated disposable CI Neon URL.');
}

const databaseUrl = new URL(adapterUrl);
if (!databaseUrl.hostname.endsWith('.neon.tech') ||
    !databaseUrl.pathname.slice(1).endsWith('_test') ||
    databaseUrl.searchParams.get('channel_binding') !== 'require' ||
    databaseUrl.searchParams.has('hostaddr')) {
  throw new Error('Refusing native adapter integration outside the strict disposable test target.');
}
if (!pg.native?.Pool || !pg.native?.Client) {
  throw new Error('pg-native is required; refusing a JavaScript-driver fallback.');
}

process.env.DATABASE_URL = adapterUrl;
const startupStarted = performance.now();
const pool = createPostgresPool(adapterUrl, {
  max: 4,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 10000
});
const memorySamples = [process.memoryUsage().rss];
const memoryTimer = setInterval(() => memorySamples.push(process.memoryUsage().rss), 50);

async function expectPoolFailure(url, pattern, label) {
  const testPool = createPostgresPool(url, { max: 1, connectionTimeoutMillis: 4000 });
  try {
    await assert.rejects(testPool.query('SELECT 1'), pattern, label);
  } finally {
    await testPool.end();
  }
}

try {
  const firstQuery = await pool.query(`SELECT current_database() AS database_name,
      current_user AS role_name,
      (SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()) AS tls_enabled,
      $1::text AS parameterized_value`, ['native-pool-ok']);
  assert.equal(firstQuery.rows[0].database_name, databaseUrl.pathname.slice(1));
  assert.equal(firstQuery.rows[0].role_name, databaseUrl.username);
  assert.equal(firstQuery.rows[0].tls_enabled, true, 'the adapter must use verified TLS');
  assert.equal(firstQuery.rows[0].parameterized_value, 'native-pool-ok');
  const firstConnectionMs = performance.now() - startupStarted;
  const migrationCount = await pool.query('SELECT count(*)::int AS count FROM schema_migrations');
  assert.ok(migrationCount.rows[0].count > 0, 'migrations must have run through the adapter before application checks');

  const acquired = await pool.connect();
  try {
    await acquired.query('BEGIN');
    await acquired.query('CREATE TEMP TABLE native_rollback_probe(value text)');
    await acquired.query('INSERT INTO native_rollback_probe VALUES ($1)', ['rolled-back']);
    await acquired.query('ROLLBACK');
    const rollback = await acquired.query("SELECT to_regclass('pg_temp.native_rollback_probe') AS table_name");
    assert.equal(rollback.rows[0].table_name, null, 'rollback must discard transactional DDL and writes');
  } finally {
    acquired.release();
  }

  const clientConnectionString = new URL(adapterUrl);
  clientConnectionString.searchParams.set('sslmode', 'verify-full');
  clientConnectionString.searchParams.set('sslrootcert', 'system');
  const adapterConnectionString = new URL(clientConnectionString);
  adapterConnectionString.searchParams.delete('sslrootcert');
  const client = new pg.native.Client({
    connectionString: adapterConnectionString.toString(),
    nativeConnectionString: clientConnectionString.toString(),
    connectionTimeoutMillis: 5000
  });
  try {
    await client.connect();
    const clientResult = await client.query('SELECT $1::int AS value', [42]);
    assert.equal(clientResult.rows[0].value, 42, 'native Client supports parameterized queries');
  } finally {
    await client.end();
  }

  const identity = await pool.query(`SELECT r.rolcanlogin, r.rolsuper, r.rolcreatedb, r.rolcreaterole,
      r.rolreplication, r.rolbypassrls, r.rolinherit,
      EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid) AS has_memberships
    FROM pg_roles r WHERE r.rolname=current_user`);
  assert.deepEqual(identity.rows[0], {
    rolcanlogin: true,
    rolsuper: false,
    rolcreatedb: false,
    rolcreaterole: false,
    rolreplication: false,
    rolbypassrls: false,
    rolinherit: false,
    has_memberships: false
  }, 'the native application connection uses a restricted database role');
  await assert.rejects(pool.query('CREATE ROLE native_adapter_must_not_create_roles'),
    /permission denied to create role/i);
  await assert.rejects(pool.query('CREATE DATABASE native_adapter_must_not_create_database'),
    /permission denied to create database/i);

  const badPassword = new URL(adapterUrl);
  badPassword.password = 'intentionally-wrong-native-ci-password';
  await expectPoolFailure(badPassword.toString(), /password authentication failed/i,
    'wrong credentials must be rejected by PostgreSQL');

  const missingRole = new URL(adapterUrl);
  missingRole.username = 'native_ci_role_that_does_not_exist';
  const roleProbe = await pool.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [missingRole.username]);
  assert.equal(roleProbe.rowCount, 0, 'the deliberately invalid login role must not exist in the disposable database');
  await expectPoolFailure(missingRole.toString(), /password authentication failed/i,
    'a missing PostgreSQL role is rejected during SCRAM authentication');

  const deniedDatabase = new URL(adapterUrl);
  deniedDatabase.pathname = '/postgres';
  await expectPoolFailure(deniedDatabase.toString(), /permission denied for database/i,
    'the application role must not connect to the admin database');

  const wrongHostname = new URL(adapterUrl);
  wrongHostname.hostname = process.env.PG_NATIVE_ADAPTER_WRONG_HOST;
  await expectPoolFailure(wrongHostname.toString(), /certificate|hostname|host name|does not match/i,
    'a hostname mismatch must fail certificate identity verification');

  const wrongAuthority = new URL(adapterUrl);
  wrongAuthority.hostname = process.env.PG_NATIVE_ADAPTER_WRONG_CA_HOST;
  wrongAuthority.port = process.env.PG_NATIVE_ADAPTER_WRONG_CA_PORT;
  await expectPoolFailure(wrongAuthority.toString(), /certificate|issuer|verify failed|self.signed/i,
    'an untrusted certificate chain must be rejected');

  const refusedPort = new URL(adapterUrl);
  refusedPort.port = '1';
  await expectPoolFailure(refusedPort.toString(), /connection refused|could not connect to server/i,
    'a TCP connection failure must remain a native connection failure');

  const disabledTls = new URL(adapterUrl);
  disabledTls.searchParams.set('sslmode', 'disable');
  assert.throws(() => createPostgresPool(disabledTls.toString()), /reject.*sslmode/i,
    'disabled TLS is rejected before a pool can be created');

  const { createPostgresStore, closeStore } = await import('../data/inventory-postgres-store.js');
  const catalog = ['SS-CI-NATIVE-001', 'SS-CI-NATIVE-002', 'SS-CI-NATIVE-003'].map((inventoryCode, index) => ({
    id: `native-ci-${index + 1}`,
    inventoryCode,
    slug: `native-ci-${index + 1}`,
    title: `Synthetic Native CI Artwork ${index + 1}`,
    category: 'Native Adapter CI',
    medium: 'Synthetic test data',
    price: '₹100',
    availability: 'Available',
    images: [],
    cardImage: null,
    preparationTime: { displayText: 'Synthetic test fixture' }
  }));
  const store = createPostgresStore({ catalog });
  try {
    await store.initializeInventory();
    const competingOrders = await Promise.all([
      store.createCartOrder({
        customer: { name: 'CI Buyer A', email: 'a@example.test', country: 'India' },
        items: [{ inventoryCode: catalog[0].inventoryCode, purchaseType: 'original' }],
        clientRequestId: `native-race-a-${Date.now()}`
      }),
      store.createCartOrder({
        customer: { name: 'CI Buyer B', email: 'b@example.test', country: 'India' },
        items: [{ inventoryCode: catalog[0].inventoryCode, purchaseType: 'original' }],
        clientRequestId: `native-race-b-${Date.now()}`
      })
    ]);
    assert.equal(competingOrders.filter(order => order.success).length, 1,
      'native inventory row locks allow one competing original reservation');
    assert.equal(competingOrders.filter(order => order.statusCode === 409).length, 1,
      'the losing native reservation receives a conflict');

    const order = await store.createCartOrder({
      customer: { name: 'CI Buyer C', email: 'c@example.test', country: 'India' },
      items: [{ inventoryCode: catalog[1].inventoryCode, purchaseType: 'original' }],
      clientRequestId: `native-payment-${Date.now()}`
    });
    assert.equal(order.success, true);
    const linked = await store.updateRazorpayOrderId(order.order.orderId, 'order_native_adapter_ci');
    assert.equal(linked.razorpayOrderId, 'order_native_adapter_ci');
    const captured = await store.updateOrderPaymentStatus(order.order.orderId, {
      paymentStatus: 'confirmed',
      razorpayPaymentId: 'pay_native_adapter_ci',
      eventId: 'evt_native_adapter_ci',
      eventType: 'payment.captured'
    });
    assert.equal(captured.success, true);
    const replay = await store.updateOrderPaymentStatus(order.order.orderId, {
      paymentStatus: 'confirmed',
      razorpayPaymentId: 'pay_native_adapter_ci',
      eventId: 'evt_native_adapter_ci',
      eventType: 'payment.captured'
    });
    assert.equal(replay.duplicate, true, 'webhook event replay is idempotent through native transactions');
    assert.equal((await store.getArtworkInventory(catalog[1].inventoryCode)).status, 'Sold');

    const failedOrder = await store.createCartOrder({
      customer: { name: 'CI Buyer D', email: 'd@example.test', country: 'India' },
      items: [{ inventoryCode: catalog[2].inventoryCode, purchaseType: 'original' }],
      clientRequestId: `native-failed-${Date.now()}`
    });
    assert.equal(failedOrder.success, true);
    const failed = await store.updateOrderPaymentStatus(failedOrder.order.orderId, {
      paymentStatus: 'failed',
      eventId: 'evt_native_failed_ci',
      eventType: 'payment.failed'
    });
    assert.equal(failed.success, true);
    assert.equal((await store.getArtworkInventory(catalog[2].inventoryCode)).status, 'Available',
      'failed payment releases the native reservation');
  } finally {
    await store.close();
    await closeStore();
  }

  console.log(`Native adapter integration passed on ${process.env.PG_VERSION}: Pool/Client, TLS, identity, role, migration schema, inventory locks, rollback, payment and webhook persistence.`);
  console.log(`Native adapter timing: first verified connection/query ${firstConnectionMs.toFixed(1)} ms; RSS now ${(process.memoryUsage().rss / 1024 / 1024).toFixed(1)} MiB.`);
} finally {
  clearInterval(memoryTimer);
  await pool.end();
  console.log(`Native adapter RSS peak sample: ${(Math.max(...memorySamples) / 1024 / 1024).toFixed(1)} MiB.`);
}
