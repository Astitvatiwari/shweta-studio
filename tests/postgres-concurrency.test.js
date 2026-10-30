import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import pg from 'pg';
import artworks from '../artworks.js';
import { postgresConnectionOptions } from '../data/postgres-connection.js';

const { Pool } = pg;
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) {
  console.log('Skipped PostgreSQL multi-connection tests: TEST_DATABASE_URL is not configured.');
  process.exit(0);
}
const databaseName = decodeURIComponent(new URL(testUrl).pathname.replace(/^\//, ''));
if (!/_test$/i.test(databaseName) || /prod/i.test(databaseName)) {
  throw new Error('Refusing destructive concurrency tests: TEST_DATABASE_URL must point to a dedicated database whose name ends in _test.');
}

const schema = `shweta_test_${crypto.randomBytes(6).toString('hex')}`;
const connectionOptions = postgresConnectionOptions(testUrl);
const adminPool = new Pool(connectionOptions);
let scopedPool;

try {
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  scopedPool = new Pool({
    ...connectionOptions,
    options: `-c search_path=${schema}`,
    max: 8
  });
  const migration = await fs.readFile(new URL('../db/migrations/001_initial_schema.sql', import.meta.url), 'utf8');
  await scopedPool.query(migration);
  process.env.DATABASE_URL = testUrl;
  const { createPostgresStore } = await import('../data/inventory-postgres-store.js');
  const store = createPostgresStore({
    query: scopedPool.query.bind(scopedPool),
    transaction: async work => {
      const client = await scopedPool.connect();
      try {
        await client.query('BEGIN');
        const result = await work(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    catalog: artworks
  });

  const customer = { name: 'Concurrency Test', email: 'concurrency@example.test', country: 'India' };
  const candidate = artworks.find(art => (!art.availability || art.availability === 'Available') && art.price && art.category !== 'Jewellery');
  assert.ok(candidate, 'catalog must contain a priced artwork for a race test');
  const code = candidate.inventoryCode.toUpperCase();
  const requests = ['race-a', 'race-b'].map(clientRequestId => store.createCartOrder({
    customer, items: [{ inventoryCode: code, purchaseType: 'original' }], clientRequestId
  }));
  const results = await Promise.all(requests);
  assert.equal(results.filter(result => result.success).length, 1, 'only one concurrent checkout may reserve a unique original');
  assert.equal(results.filter(result => result.statusCode === 409).length, 1, 'the other concurrent checkout must be rejected');

  const winner = results.find(result => result.success).order;

  const confirmations = await Promise.all([1, 2].map(() => store.updateOrderPaymentStatus(winner.orderId, {
    paymentStatus: 'confirmed', razorpayPaymentId: 'pay_race_test',
    eventId: 'evt_race_test', eventType: 'payment.captured'
  })));
  assert.ok(confirmations.every(result => result.success), 'concurrent replay of one verified payment remains successful and idempotent');
  const eventCount = await scopedPool.query('SELECT count(*)::int AS count FROM payment_events WHERE event_id=$1', ['evt_race_test']);
  assert.equal(eventCount.rows[0].count, 1, 'concurrent payment replay records one event');
  assert.equal((await store.getArtworkInventory(code)).status, 'Sold', 'confirmed payment sells the reserved original once');

  const remaining = artworks.filter(art => (!art.availability || art.availability === 'Available') && art.price &&
    art.category !== 'Jewellery' && art.inventoryCode.toUpperCase() !== code);
  assert.ok(remaining.length > 1, 'catalog needs separate originals for duplicate and expiry scenarios');
  const duplicateCode = remaining[0].inventoryCode.toUpperCase();
  const duplicateRequests = await Promise.all([1, 2].map(() => store.createCartOrder({
    customer, items: [{ inventoryCode: duplicateCode, purchaseType: 'original' }], clientRequestId: 'same-request-id'
  })));
  assert.ok(duplicateRequests.every(result => result.success), 'concurrent retry with the same idempotency key returns success');
  assert.equal(new Set(duplicateRequests.map(result => result.order.orderId)).size, 1,
    'concurrent duplicate purchases with one request ID create one order');

  const expiryCode = remaining[1].inventoryCode.toUpperCase();
  const expiryOrder = await store.createCartOrder({
    customer, items: [{ inventoryCode: expiryCode, purchaseType: 'original' }], clientRequestId: 'expiry-request-id'
  });
  assert.equal(expiryOrder.success, true);
  await scopedPool.query(`UPDATE inventory SET reserved_until=now()-interval '1 second'
    WHERE inventory_code=$1 AND reserved_order_id=$2`, [expiryCode, expiryOrder.order.orderId]);
  const expired = await store.getArtworkInventory(expiryCode);
  assert.equal(expired.status, 'Available', 'expired checkout reservation is released');
  const replacement = await store.createCartOrder({
    customer, items: [{ inventoryCode: expiryCode, purchaseType: 'original' }], clientRequestId: 'replacement-request-id'
  });
  assert.equal(replacement.success, true, 'a new purchaser may reserve an artwork after expiry');
  const lateCapture = await store.updateOrderPaymentStatus(expiryOrder.order.orderId, {
    paymentStatus: 'confirmed', razorpayPaymentId: 'pay_late_test'
  });
  assert.equal(lateCapture.success, false, 'a late capture cannot sell an artwork held by the replacement order');
  assert.equal(lateCapture.statusCode, 400);
  const protectedReplacement = await store.getArtworkInventory(expiryCode);
  assert.equal(protectedReplacement.reservedOrderId, replacement.order.orderId,
    'the late capture cannot release or steal the replacement reservation');
  console.log('PostgreSQL multi-connection concurrency and expiry tests passed.');
} finally {
  if (scopedPool) await scopedPool.end();
  await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
  await adminPool.end();
}
