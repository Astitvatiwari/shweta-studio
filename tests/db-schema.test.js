import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import crypto from 'node:crypto';
import { safeAdminKeyMatch, verifyNetlifyProxySignature } from '../security/request-security.js';
import { postgresConnectionOptions } from '../data/postgres-connection.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migration = await fs.readFile(path.join(root, 'db/migrations/001_initial_schema.sql'), 'utf8');
const db = new PGlite();
process.env.DATABASE_URL = 'postgres://schema-test:unused@127.0.0.1:1/schema_test';
const { createPostgresStore } = await import('../data/inventory-postgres-store.js');
const store = createPostgresStore({
  query: db.query.bind(db),
  transaction: work => db.transaction(tx => work(tx))
});

try {
  await db.exec(migration);
  await db.query(`INSERT INTO inventory (inventory_code, status, original_quantity, data)
    VALUES ('SS-PT-006', 'Available', 1, '{"inventoryCode":"SS-PT-006"}')`);
  await db.query(`INSERT INTO orders (order_id, client_request_id, order_type, payment_status, order_data)
    VALUES ('ORD-test', 'request-1', 'original', 'payment_pending', '{"orderId":"ORD-test"}')`);
  await db.query(`INSERT INTO order_items (order_id, item_index, inventory_code, purchase_type, quantity, item_data)
    VALUES ('ORD-test', 0, 'SS-PT-006', 'original', 1, '{"inventoryCode":"SS-PT-006"}')`);

  await assert.rejects(
    db.query(`INSERT INTO orders (order_id, client_request_id, order_type, payment_status, order_data)
      VALUES ('ORD-duplicate', 'request-1', 'original', 'payment_pending', '{}')`),
    /unique constraint/i,
    'client request IDs must be idempotent'
  );
  await assert.rejects(
    db.query(`INSERT INTO inventory (inventory_code, status, original_quantity, data)
      VALUES ('SS-PT-007', 'Reserved', 0, '{}')`),
    /check constraint/i,
    'checkout reservations must include their expiry and order reference'
  );

  await db.query(`UPDATE inventory SET status = 'Reserved', original_quantity = 0,
    reservation_type = 'checkout_hold', reserved_until = now() + interval '15 minutes',
    reserved_order_id = 'ORD-test' WHERE inventory_code = 'SS-PT-006'`);
  const { rows } = await db.query('SELECT status, reserved_order_id FROM inventory WHERE inventory_code = $1', ['SS-PT-006']);
  assert.deepEqual(rows[0], { status: 'Reserved', reserved_order_id: 'ORD-test' });

  // Exercise the same PostgreSQL adapter used in production against an isolated
  // PostgreSQL-compatible in-memory instance. No hosted database is contacted.
  const catalog = await store.getInventory();
  assert.ok(catalog['SS-PT-006'], 'store seeds catalog inventory from artworks.js');
  const artworkCode = Object.values(catalog).find(item => item.status === 'Available' && item.price)?.inventoryCode;
  assert.ok(artworkCode, 'catalog includes an available priced original');
  const customer = { name: 'Test Collector', email: 'collector@example.test', country: 'India' };
  const request = { customer, items: [{ inventoryCode: artworkCode, purchaseType: 'original' }], clientRequestId: 'pg-idem-1' };
  const created = await store.createCartOrder(request);
  assert.equal(created.success, true);
  assert.equal(created.statusCode, 201);
  const reserved = await store.getArtworkInventory(artworkCode);
  assert.equal(reserved.reservationType, 'checkout_hold');
  assert.equal(reserved.reservedOrderId, created.order.orderId);

  const repeated = await store.createCartOrder(request);
  assert.equal(repeated.order.orderId, created.order.orderId, 'duplicate client request returns the same order');
  const blocked = await store.createCartOrder({ ...request, clientRequestId: 'pg-idem-2' });
  assert.equal(blocked.success, false);
  assert.equal(blocked.statusCode, 409, 'a second order cannot reserve a held original');

  const linkedGatewayOrder = await store.updateRazorpayOrderId(created.order.orderId, 'order_schema_test_1');
  assert.equal(linkedGatewayOrder.razorpayOrderId, 'order_schema_test_1',
    'Razorpay order references persist through the migrated PostgreSQL column');
  const noOverwrite = await store.updateRazorpayOrderId(created.order.orderId, 'order_schema_test_2');
  assert.equal(noOverwrite.razorpayOrderId, 'order_schema_test_1',
    'an existing provider order reference is never overwritten on retry');
  const persistedRow = await db.query('SELECT razorpay_order_id FROM orders WHERE order_id=$1', [created.order.orderId]);
  assert.equal(persistedRow.rows[0].razorpay_order_id, 'order_schema_test_1');

  const paid = await store.updateOrderPaymentStatus(created.order.orderId, {
    paymentStatus: 'confirmed', razorpayPaymentId: 'pay_test_1'
  });
  assert.equal(paid.success, true);
  assert.equal((await store.getArtworkInventory(artworkCode)).status, 'Sold');
  const replay = await store.updateOrderPaymentStatus(created.order.orderId, {
    paymentStatus: 'confirmed', razorpayPaymentId: 'pay_test_1', eventId: 'evt_test_1', eventType: 'payment.captured'
  });
  assert.equal(replay.success, true, 'same verified payment replay is idempotent');

  const secondCode = Object.values(await store.getInventory()).find(item => item.status === 'Available' && item.price && item.inventoryCode !== artworkCode)?.inventoryCode;
  const pending = await store.createCartOrder({ customer, items: [{ inventoryCode: secondCode, purchaseType: 'original' }], clientRequestId: 'pg-fail-1' });
  assert.equal(pending.success, true);
  const failed = await store.updateOrderPaymentStatus(pending.order.orderId, { paymentStatus: 'failed', eventId: 'evt_test_fail', eventType: 'payment.failed' });
  assert.equal(failed.success, true);
  assert.equal((await store.getArtworkInventory(secondCode)).status, 'Available', 'failed payment releases only its checkout hold');

  const expiryCode = Object.values(await store.getInventory()).find(item => item.status === 'Available' && item.price &&
    item.inventoryCode !== artworkCode && item.inventoryCode !== secondCode)?.inventoryCode;
  const expiryOrder = await store.createCartOrder({ customer, items: [{ inventoryCode: expiryCode, purchaseType: 'original' }], clientRequestId: 'pg-expiry-1' });
  await db.query(`UPDATE inventory SET reserved_until=now() - interval '1 second' WHERE inventory_code=$1`, [expiryCode]);
  await store.cleanExpiredReservations();
  const lateCapture = await store.updateOrderPaymentStatus(expiryOrder.order.orderId, {
    paymentStatus: 'confirmed', razorpayPaymentId: 'pay_late_capture'
  });
  assert.equal(lateCapture.success, false, 'a capture after its hold expires is flagged for reconciliation');
  assert.equal(lateCapture.statusCode, 400, 'expired orders reject a late confirmed transition');
  assert.equal((await store.getArtworkInventory(expiryCode)).status, 'Available', 'late capture does not sell an artwork held by another order');

  const signingSecret = 'test-only-proxy-secret';
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = encode({ iss: 'netlify', exp: 2000, site_url: 'https://preview.example.test' });
  const signature = crypto.createHmac('sha256', signingSecret).update(`${header}.${payload}`).digest('base64url');
  const token = `${header}.${payload}.${signature}`;
  assert.equal(verifyNetlifyProxySignature(token, signingSecret, { nowSeconds: 1000, expectedSiteUrl: 'https://preview.example.test' }), true);
  assert.equal(verifyNetlifyProxySignature(token, signingSecret, { nowSeconds: 3000 }), false, 'expired proxy signatures are rejected');
  assert.equal(verifyNetlifyProxySignature(`${header}.${payload}.broken`, signingSecret, { nowSeconds: 1000 }), false, 'forged proxy signatures are rejected');
  assert.equal(safeAdminKeyMatch('wrong', 'right'), false);
  assert.equal(safeAdminKeyMatch('same-secret', 'same-secret'), true);

  const pgConfig = postgresConnectionOptions('postgres://test:password@db.example.test/shweta_studio_test?sslmode=require', {
    sslMode: 'require', production: true
  });
  assert.equal(pgConfig.ssl.rejectUnauthorized, true, 'external PostgreSQL hosts retain TLS certificate verification');
  assert.equal(new URL(pgConfig.connectionString).searchParams.has('sslmode'), false, 'connection-string SSL parameters cannot override explicit TLS policy');
  const renderInternalConfig = postgresConnectionOptions('postgres://test:password@dpg-cvabc123-a:5432/shweta_studio?sslmode=require', {
    sslMode: 'require', production: true
  });
  assert.notEqual(renderInternalConfig.ssl, false, 'Render internal PostgreSQL connections remain TLS-encrypted');
  assert.equal(renderInternalConfig.ssl.rejectUnauthorized, false, 'self-signed certificate validation is bypassed only for Render internal PostgreSQL hosts');
  const renderExternalConfig = postgresConnectionOptions('postgres://test:password@dpg-cvabc123-a.singapore-postgres.render.com/shweta_studio?sslmode=require', {
    sslMode: 'require', production: true
  });
  assert.equal(renderExternalConfig.ssl.rejectUnauthorized, true, 'Render external PostgreSQL hosts retain certificate verification');
  assert.throws(() => postgresConnectionOptions('postgres://test:password@localhost/shweta_studio_test', {
    sslMode: 'disable', production: true
  }), /cannot be disabled in production/i);

  console.log('PostgreSQL schema, store, and proxy-signature regression checks passed.');
} finally {
  await db.close();
}
