import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import pg from 'pg';
import artworks from '../artworks.js';
import { postgresConnectionOptions } from '../data/postgres-connection.js';

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) {
  console.log('Skipped PostgreSQL payment-webhook integration tests: TEST_DATABASE_URL is not configured.');
  process.exit(0);
}
const parsedTestUrl = new URL(testUrl);
const databaseName = decodeURIComponent(parsedTestUrl.pathname.replace(/^\//, ''));
if (!databaseName.toLowerCase().endsWith('_test') || /prod/i.test(databaseName) ||
    !['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsedTestUrl.hostname)) {
  throw new Error('Refusing webhook integration tests: TEST_DATABASE_URL must point to a loopback-only database whose name ends in _test.');
}

const { Pool } = pg;
const schema = `shweta_webhook_test_${crypto.randomBytes(6).toString('hex')}`;
const adminOptions = postgresConnectionOptions(testUrl);
const adminPool = new Pool(adminOptions);
let appPool;
let server;
let closeStore = async () => {};
const originalFetch = globalThis.fetch;
const originalEnv = {
  NODE_ENV: process.env.NODE_ENV,
  STORAGE_BACKEND: process.env.STORAGE_BACKEND,
  DATABASE_URL: process.env.DATABASE_URL,
  RAZORPAY_WEBHOOK_SECRET: process.env.RAZORPAY_WEBHOOK_SECRET,
  RAZORPAY_KEY_ID: process.env.RAZORPAY_KEY_ID,
  RAZORPAY_KEY_SECRET: process.env.RAZORPAY_KEY_SECRET,
  API_RATE_LIMIT_PER_PROXY: process.env.API_RATE_LIMIT_PER_PROXY
};
const testWebhookSecret = 'local-only-phase6-webhook-secret';
const testKeyId = 'rzp_test_phase6_mock';
const testKeySecret = 'local-only-phase6-api-secret';
const providerResults = new Map();
let providerCalls = 0;

function setEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function quoteIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function signedBody(payload) {
  const rawBody = JSON.stringify(payload);
  const signature = crypto.createHmac('sha256', testWebhookSecret).update(rawBody).digest('hex');
  return { rawBody, signature };
}

async function sendWebhook(payload, eventId) {
  const { rawBody, signature } = signedBody(payload);
  const response = await originalFetch(`http://127.0.0.1:${server.address().port}/api/payment/webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Razorpay-Signature': signature,
      'X-Razorpay-Event-Id': eventId
    },
    body: rawBody
  });
  return { response, body: await response.json() };
}

async function sendCheckoutVerification(order, paymentId, gatewayOrderId = order.razorpayOrderId) {
  const signature = crypto.createHmac('sha256', testKeySecret)
    .update(`${gatewayOrderId}|${paymentId}`).digest('hex');
  const response = await originalFetch(`http://127.0.0.1:${server.address().port}/api/checkout/verify-payment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId: order.orderId, razorpayOrderId: gatewayOrderId,
      razorpayPaymentId: paymentId, razorpaySignature: signature })
  });
  return { response, body: await response.json() };
}

function capturedProviderPayment(order, paymentId, overrides = {}) {
  return {
    id: paymentId,
    order_id: order.razorpayOrderId,
    amount: Math.round(order.subtotalNumeric * 100),
    currency: order.currency,
    status: 'captured',
    notes: { orderId: order.orderId },
    ...overrides
  };
}

async function createReservedOrder(store, clientRequestId, art) {
  const created = await store.createCartOrder({
    customer: { name: 'Phase 6 Synthetic', email: `${clientRequestId}@example.invalid`, country: 'India' },
    items: [{ inventoryCode: art.inventoryCode, purchaseType: 'original', quantity: 1 }],
    clientRequestId
  });
  assert.equal(created.success, true, `synthetic order ${clientRequestId} should reserve in the isolated schema`);
  const razorpayOrderId = `order_phase6${crypto.randomBytes(5).toString('hex')}`;
  const linked = await store.updateRazorpayOrderId(created.order.orderId, razorpayOrderId);
  assert.equal(linked.razorpayOrderId, razorpayOrderId);
  return { ...created.order, razorpayOrderId, inventoryCode: art.inventoryCode };
}

function eventFor(order, paymentId, overrides = {}) {
  return {
    event: 'payment.captured',
    payload: { payment: { entity: {
      id: paymentId,
      order_id: order.razorpayOrderId,
      notes: { orderId: order.orderId },
      amount: Math.round(order.subtotalNumeric * 100),
      currency: order.currency,
      status: 'captured',
      ...overrides
    } } }
  };
}

async function assertUnconfirmed(pool, store, order) {
  const row = await pool.query(`SELECT payment_status, razorpay_payment_id,
      (SELECT count(*)::int FROM payment_events WHERE order_id=orders.order_id) AS event_count
    FROM orders WHERE order_id=$1`, [order.orderId]);
  assert.equal(row.rowCount, 1);
  assert.equal(row.rows[0].payment_status, 'payment_pending');
  assert.equal(row.rows[0].razorpay_payment_id, null);
  assert.equal(row.rows[0].event_count, 0);
  const inventory = await store.getArtworkInventory(order.inventoryCode);
  assert.equal(inventory.status, 'Reserved');
  assert.equal(inventory.reservationType, 'checkout_hold');
  assert.equal(inventory.reservedOrderId, order.orderId);
  assert.equal(inventory.originalQuantity, 0);
}

try {
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  const scopedUrl = new URL(process.env.PG_NATIVE_ADAPTER_CI === 'true'
    ? process.env.PG_NATIVE_ADAPTER_DATABASE_URL
    : testUrl);
  scopedUrl.searchParams.set('options', `-c search_path=${schema}`);
  process.env.DATABASE_URL = scopedUrl.toString();
  process.env.NODE_ENV = 'test';
  process.env.STORAGE_BACKEND = 'postgres';
  process.env.RAZORPAY_WEBHOOK_SECRET = testWebhookSecret;
  process.env.RAZORPAY_KEY_ID = testKeyId;
  process.env.RAZORPAY_KEY_SECRET = testKeySecret;
  process.env.API_RATE_LIMIT_PER_PROXY = '300';

  const appConnectionUrl = new URL(process.env.PG_NATIVE_ADAPTER_CI === 'true'
    ? process.env.PG_NATIVE_ADAPTER_DATABASE_URL
    : testUrl);
  appConnectionUrl.searchParams.set('options', `-c search_path=${schema}`);
  appPool = process.env.PG_NATIVE_ADAPTER_CI === 'true'
    ? (await import('../data/postgres-pool.js')).createPostgresPool(appConnectionUrl.toString(), { max: 4 })
    : new Pool({ ...postgresConnectionOptions(appConnectionUrl.toString()), max: 4 });

  const adminIdentity = await adminPool.query(
    'SELECT current_database() AS database_name, current_user AS role_name'
  );
  const appIdentity = await appPool.query(`
    SELECT current_database() AS database_name,
      current_user AS role_name,
      current_setting('search_path') AS search_path
  `);
  assert.equal(appIdentity.rows[0].database_name, databaseName,
    'application connection must use the loopback disposable test database');
  assert.equal(adminIdentity.rows[0].database_name, appIdentity.rows[0].database_name,
    'fixture administrator and migration role must use the same disposable database');
  assert.equal(appIdentity.rows[0].search_path, schema,
    'migration role must have the temporary fixture schema in its search_path');

  const appRole = appIdentity.rows[0].role_name;
  if (process.env.PG_NATIVE_ADAPTER_CI === 'true') {
    assert.notEqual(appRole, adminIdentity.rows[0].role_name,
      'native adapter migrations must run as the restricted application role');
    const roleFlags = await adminPool.query(`
      SELECT rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolbypassrls
      FROM pg_roles WHERE rolname = $1
    `, [appRole]);
    assert.equal(roleFlags.rowCount, 1, 'migration role must exist in the disposable database');
    assert.equal(roleFlags.rows[0].rolsuper, false, 'migration role must not be a superuser');
    assert.equal(roleFlags.rows[0].rolcreatedb, false, 'migration role must not create databases');
    assert.equal(roleFlags.rows[0].rolcreaterole, false, 'migration role must not create roles');
    assert.equal(roleFlags.rows[0].rolinherit, false, 'migration role must not inherit elevated roles');
    assert.equal(roleFlags.rows[0].rolbypassrls, false, 'migration role must not bypass row security');
  }

  const initialSchemaPrivileges = await adminPool.query(`
    SELECT has_schema_privilege($1, $2, 'USAGE') AS can_use,
      has_schema_privilege($1, $2, 'CREATE') AS can_create
  `, [appRole, schema]);
  if (!initialSchemaPrivileges.rows[0].can_use || !initialSchemaPrivileges.rows[0].can_create) {
    await adminPool.query(
      `GRANT USAGE, CREATE ON SCHEMA ${quoteIdentifier(schema)} TO ${quoteIdentifier(appRole)}`
    );
  }
  const grantedSchemaPrivileges = await adminPool.query(`
    SELECT has_schema_privilege($1, $2, 'USAGE') AS can_use,
      has_schema_privilege($1, $2, 'CREATE') AS can_create
  `, [appRole, schema]);
  assert.equal(grantedSchemaPrivileges.rows[0].can_use, true,
    'migration role must have USAGE on its one temporary fixture schema');
  assert.equal(grantedSchemaPrivileges.rows[0].can_create, true,
    'migration role must have CREATE on its one temporary fixture schema');
  const effectiveSearchPath = await appPool.query(`
    SELECT current_schemas(false) AS schemas, current_setting('search_path') AS search_path
  `);
  assert.ok(effectiveSearchPath.rows[0].schemas.includes(schema),
    'temporary fixture schema must be effective in the migration role search_path');
  console.log(`Webhook fixture database=${databaseName}; migration_role=${appRole}; search_path=${schema}; schema grants=USAGE,CREATE on fixture schema only.`);

  const migration = await fs.readFile(new URL('../db/migrations/001_initial_schema.sql', import.meta.url), 'utf8');
  await appPool.query(migration);

  globalThis.fetch = async (input, init = {}) => {
    const requestUrl = new URL(typeof input === 'string' ? input : input.url);
    if (requestUrl.hostname === 'api.razorpay.com' && requestUrl.pathname.startsWith('/v1/payments/')) {
      providerCalls++;
      assert.equal(init.method, 'GET');
      assert.equal(init.headers.Authorization, `Basic ${Buffer.from(`${testKeyId}:${testKeySecret}`).toString('base64')}`);
      const paymentId = decodeURIComponent(requestUrl.pathname.slice('/v1/payments/'.length));
      const result = providerResults.get(paymentId);
      if (result?.throw) throw result.throw;
      return new Response(JSON.stringify(result?.body || { error: 'not found' }), { status: result ? (result.status ?? 200) : 404 });
    }
    throw new Error('Unexpected external network request blocked by the webhook integration test.');
  };

  const store = await import('../data/inventory-store.js');
  closeStore = store.closeStore;
  const app = await import('../server.js');
  server = await app.startServer(0);

  const candidates = artworks.filter(art => (!art.availability || art.availability === 'Available') && art.price);
  assert.ok(candidates.length >= 28, 'catalog needs enough independent available originals for webhook, callback, and expiry cases');
  let candidateIndex = 0;
  const nextOrder = label => createReservedOrder(store,
    `phase6-${label}-${crypto.randomBytes(4).toString('hex')}`, candidates[candidateIndex++]);

  // A single captured event may be delivered more than once. The provider says
  // captured, and the same provider order, amount, and currency must all match.
  const validOrder = await nextOrder('valid');
  const validPaymentId = 'pay_phase6valid';
  const validEvent = eventFor(validOrder, validPaymentId);
  providerResults.set(validPaymentId, { body: {
    id: validPaymentId, order_id: validOrder.razorpayOrderId,
    amount: validEvent.payload.payment.entity.amount, currency: validOrder.currency,
    status: 'captured', notes: { orderId: validOrder.orderId }
  } });
  const [valid, concurrentValid] = await Promise.all([
    sendWebhook(validEvent, 'evt-phase6-valid'),
    sendWebhook(validEvent, 'evt-phase6-valid')
  ]);
  assert.equal(valid.response.status, 200);
  assert.equal(valid.body.order.paymentStatus, 'confirmed');
  assert.equal(concurrentValid.response.status, 200);
  const providerCallsBeforeReplay = providerCalls;
  providerResults.set(validPaymentId, { status: 503, body: { error: 'verification unavailable after first confirmation' } });
  const validReplay = await sendWebhook(validEvent, 'evt-phase6-valid');
  assert.equal(validReplay.response.status, 200);
  assert.equal(validReplay.body.duplicate, true);
  assert.equal(providerCalls, providerCallsBeforeReplay, 'already-confirmed duplicate is acknowledged without a new provider lookup');
  const validRows = await appPool.query(`SELECT payment_status, razorpay_payment_id,
      (SELECT count(*)::int FROM payment_events WHERE order_id=orders.order_id) AS event_count
    FROM orders WHERE order_id=$1`, [validOrder.orderId]);
  assert.equal(validRows.rows[0].payment_status, 'confirmed');
  assert.equal(validRows.rows[0].razorpay_payment_id, validPaymentId);
  assert.equal(validRows.rows[0].event_count, 1, 'duplicate delivery records one event');
  assert.equal((await store.getArtworkInventory(validOrder.inventoryCode)).status, 'Sold');

  // The browser callback must independently verify the provider's captured
  // payment. The same payment rules and persistence transaction are used as
  // the webhook path.
  const callbackOrder = await nextOrder('callback-valid');
  const callbackPaymentId = 'pay_phase6callbackvalid';
  providerResults.set(callbackPaymentId, { body: capturedProviderPayment(callbackOrder, callbackPaymentId) });
  const callbackResult = await sendCheckoutVerification(callbackOrder, callbackPaymentId);
  assert.equal(callbackResult.response.status, 200);
  assert.equal(callbackResult.body.order.paymentStatus, 'confirmed');
  assert.equal((await store.getArtworkInventory(callbackOrder.inventoryCode)).status, 'Sold');
  const providerCallsBeforeCallbackReplay = providerCalls;
  const callbackReplay = await sendCheckoutVerification(callbackOrder, callbackPaymentId);
  assert.equal(callbackReplay.response.status, 200);
  assert.equal(callbackReplay.body.duplicate, true);
  assert.equal(providerCalls, providerCallsBeforeCallbackReplay, 'confirmed callback replay should be idempotent without provider lookup');

  for (const status of ['authorized', 'pending', 'failed']) {
    const order = await nextOrder(`callback-status-${status}`);
    const paymentId = `pay_phase6callback${status}`;
    providerResults.set(paymentId, { body: capturedProviderPayment(order, paymentId, { status }) });
    if (status === 'authorized') {
      const beforeMismatch = providerCalls;
      const mismatchedRequest = await sendCheckoutVerification(order, paymentId, 'order_wrongcallback');
      assert.equal(mismatchedRequest.response.status, 400);
      assert.equal(providerCalls, beforeMismatch, 'locally unlinked callback gateway ID must be rejected before provider lookup');
      await assertUnconfirmed(appPool, store, order);
    }
    const result = await sendCheckoutVerification(order, paymentId);
    assert.equal(result.response.status, 503, `${status} payment callback must remain retryable until captured`);
    assert.equal(result.body.retryable, true);
    await assertUnconfirmed(appPool, store, order);
  }

  for (const [label, overrides] of [
    ['order', { order_id: 'order_anothercallback' }],
    ['amount', { amount: 1 }],
    ['currency', { currency: 'USD' }]
  ]) {
    const order = await nextOrder(`callback-mismatch-${label}`);
    const paymentId = `pay_phase6callbackmismatch${label}`;
    providerResults.set(paymentId, { body: capturedProviderPayment(order, paymentId, overrides) });
    const result = await sendCheckoutVerification(order, paymentId);
    assert.equal(result.response.status, 400, `provider ${label} mismatch must be rejected`);
    await assertUnconfirmed(appPool, store, order);
  }

  const callbackWrongPaymentOrder = await nextOrder('callback-payment-id-mismatch');
  const callbackRequestedPaymentId = 'pay_phase6callbackrequested';
  providerResults.set(callbackRequestedPaymentId, { body: capturedProviderPayment(
    callbackWrongPaymentOrder, 'pay_phase6callbackdifferent'
  ) });
  const callbackWrongPayment = await sendCheckoutVerification(callbackWrongPaymentOrder, callbackRequestedPaymentId);
  assert.equal(callbackWrongPayment.response.status, 503, 'provider response for another payment ID must fail closed');
  await assertUnconfirmed(appPool, store, callbackWrongPaymentOrder);

  for (const failure of [
    { status: 503, body: { error: 'temporary provider failure' } },
    { throw: new Error('simulated network error') }
  ]) {
    const order = await nextOrder('callback-provider-failure');
    const paymentId = `pay_phase6callbackfailure${candidateIndex}`;
    providerResults.set(paymentId, failure);
    const result = await sendCheckoutVerification(order, paymentId);
    assert.equal(result.response.status, 503);
    assert.equal(result.body.retryable, true);
    assert.doesNotMatch(JSON.stringify(result.body), /secret|stack|simulated network/i);
    await assertUnconfirmed(appPool, store, order);
  }

  // Callback and a signed capture webhook may race. Both verify the same
  // provider record, while the row lock permits only one inventory transition.
  const raceOrder = await nextOrder('callback-webhook-race');
  const racePaymentId = 'pay_phase6callbackwebhookrace';
  const raceEvent = eventFor(raceOrder, racePaymentId);
  providerResults.set(racePaymentId, { body: capturedProviderPayment(raceOrder, racePaymentId) });
  const [raceCallback, raceWebhook] = await Promise.all([
    sendCheckoutVerification(raceOrder, racePaymentId),
    sendWebhook(raceEvent, 'evt-phase6-callback-webhook-race')
  ]);
  assert.equal(raceCallback.response.status, 200);
  assert.equal(raceWebhook.response.status, 200);
  const raceRow = await appPool.query(`SELECT payment_status, razorpay_payment_id,
      (SELECT count(*)::int FROM payment_events WHERE order_id=orders.order_id) AS event_count
    FROM orders WHERE order_id=$1`, [raceOrder.orderId]);
  assert.equal(raceRow.rows[0].payment_status, 'confirmed');
  assert.equal(raceRow.rows[0].razorpay_payment_id, racePaymentId);
  assert.equal(raceRow.rows[0].event_count, 1, 'callback/webhook race must record the signed event once');
  assert.equal((await store.getArtworkInventory(raceOrder.inventoryCode)).status, 'Sold');

  // A delayed provider verification after a hold expires must not sell an
  // artwork that another checkout has reserved. The captured payment remains
  // available for studio reconciliation rather than silently stealing stock.
  const lateOrder = await nextOrder('callback-after-expiry');
  const latePaymentId = 'pay_phase6callbacklate';
  providerResults.set(latePaymentId, { body: capturedProviderPayment(lateOrder, latePaymentId) });
  await appPool.query(`UPDATE inventory SET reserved_until=now()-interval '1 second'
    WHERE inventory_code=$1 AND reserved_order_id=$2`, [lateOrder.inventoryCode, lateOrder.orderId]);
  assert.equal((await store.getArtworkInventory(lateOrder.inventoryCode)).status, 'Available');
  const replacement = await store.createCartOrder({
    customer: { name: 'Phase 6 Synthetic Replacement', email: 'replacement@example.invalid', country: 'India' },
    items: [{ inventoryCode: lateOrder.inventoryCode, purchaseType: 'original', quantity: 1 }],
    clientRequestId: `phase6-replacement-${crypto.randomBytes(4).toString('hex')}`
  });
  assert.equal(replacement.success, true);
  const lateCallback = await sendCheckoutVerification(lateOrder, latePaymentId);
  assert.equal(lateCallback.response.status, 400, 'expired order cannot be auto-confirmed after its reservation ended');
  const protectedInventory = await store.getArtworkInventory(lateOrder.inventoryCode);
  assert.equal(protectedInventory.status, 'Reserved');
  assert.equal(protectedInventory.reservedOrderId, replacement.order.orderId);

  // A signed capture event cannot confirm a payment that Razorpay still reports
  // as authorized/pending/failed.
  for (const status of ['authorized', 'pending', 'failed']) {
    const order = await nextOrder(`status-${status}`);
    const paymentId = `pay_phase6${status}`;
    providerResults.set(paymentId, { body: {
      id: paymentId, order_id: order.razorpayOrderId,
      amount: Math.round(order.subtotalNumeric * 100), currency: order.currency, status
    } });
    const result = await sendWebhook(eventFor(order, paymentId), `evt-phase6-${status}`);
    assert.equal(result.response.status, 503, `${status} provider status should be retryable and not confirmed`);
    await assertUnconfirmed(appPool, store, order);
  }

  for (const status of ['authorized', 'pending', 'failed']) {
    const order = await nextOrder(`payload-status-${status}`);
    const paymentId = `pay_phase6payload${status}`;
    providerResults.set(paymentId, { body: {
      id: paymentId, order_id: order.razorpayOrderId,
      amount: Math.round(order.subtotalNumeric * 100), currency: order.currency, status: 'captured'
    } });
    const result = await sendWebhook(eventFor(order, paymentId, { status }), `evt-phase6-payload-${status}`);
    assert.equal(result.response.status, 503, `payload ${status} status should not confirm a capture`);
    await assertUnconfirmed(appPool, store, order);
  }

  const wrongPayloadOrder = await nextOrder('payload-order-mismatch');
  const wrongPayloadPayment = 'pay_phase6payloadorder';
  providerResults.set(wrongPayloadPayment, { body: {
    id: wrongPayloadPayment, order_id: wrongPayloadOrder.razorpayOrderId,
    amount: Math.round(wrongPayloadOrder.subtotalNumeric * 100), currency: wrongPayloadOrder.currency, status: 'captured'
  } });
  const beforeWrongPayload = providerCalls;
  const wrongPayloadOrderResult = await sendWebhook(
    eventFor(wrongPayloadOrder, wrongPayloadPayment, { order_id: 'order_wrongphase6' }), 'evt-phase6-payload-order'
  );
  assert.equal(wrongPayloadOrderResult.response.status, 400);
  assert.equal(providerCalls, beforeWrongPayload, 'locally mismatched gateway order is rejected before provider lookup');
  await assertUnconfirmed(appPool, store, wrongPayloadOrder);

  const wrongProviderOrder = await nextOrder('provider-order-mismatch');
  const wrongProviderOrderPayment = 'pay_phase6providerorder';
  providerResults.set(wrongProviderOrderPayment, { body: {
    id: wrongProviderOrderPayment, order_id: 'order_otherphase6',
    amount: Math.round(wrongProviderOrder.subtotalNumeric * 100), currency: wrongProviderOrder.currency, status: 'captured'
  } });
  const wrongProviderOrderResult = await sendWebhook(
    eventFor(wrongProviderOrder, wrongProviderOrderPayment), 'evt-phase6-provider-order'
  );
  assert.equal(wrongProviderOrderResult.response.status, 400);
  await assertUnconfirmed(appPool, store, wrongProviderOrder);

  const wrongPayloadAmountOrder = await nextOrder('payload-amount-mismatch');
  const wrongPayloadAmountPayment = 'pay_phase6payloadamount';
  providerResults.set(wrongPayloadAmountPayment, { body: {
    id: wrongPayloadAmountPayment, order_id: wrongPayloadAmountOrder.razorpayOrderId,
    amount: Math.round(wrongPayloadAmountOrder.subtotalNumeric * 100), currency: wrongPayloadAmountOrder.currency, status: 'captured'
  } });
  const wrongPayloadAmountResult = await sendWebhook(
    eventFor(wrongPayloadAmountOrder, wrongPayloadAmountPayment, { amount: 1 }), 'evt-phase6-payload-amount'
  );
  assert.equal(wrongPayloadAmountResult.response.status, 400);
  await assertUnconfirmed(appPool, store, wrongPayloadAmountOrder);

  const wrongProviderAmountOrder = await nextOrder('provider-amount-mismatch');
  const wrongProviderAmountPayment = 'pay_phase6provideramount';
  providerResults.set(wrongProviderAmountPayment, { body: {
    id: wrongProviderAmountPayment, order_id: wrongProviderAmountOrder.razorpayOrderId,
    amount: 1, currency: wrongProviderAmountOrder.currency, status: 'captured'
  } });
  const wrongProviderAmountResult = await sendWebhook(
    eventFor(wrongProviderAmountOrder, wrongProviderAmountPayment), 'evt-phase6-provider-amount'
  );
  assert.equal(wrongProviderAmountResult.response.status, 400);
  await assertUnconfirmed(appPool, store, wrongProviderAmountOrder);

  const wrongPayloadCurrencyOrder = await nextOrder('payload-currency-mismatch');
  const wrongPayloadCurrencyPayment = 'pay_phase6payloadcurrency';
  providerResults.set(wrongPayloadCurrencyPayment, { body: {
    id: wrongPayloadCurrencyPayment, order_id: wrongPayloadCurrencyOrder.razorpayOrderId,
    amount: Math.round(wrongPayloadCurrencyOrder.subtotalNumeric * 100), currency: wrongPayloadCurrencyOrder.currency, status: 'captured'
  } });
  const wrongPayloadCurrencyResult = await sendWebhook(
    eventFor(wrongPayloadCurrencyOrder, wrongPayloadCurrencyPayment, { currency: 'USD' }), 'evt-phase6-payload-currency'
  );
  assert.equal(wrongPayloadCurrencyResult.response.status, 400);
  await assertUnconfirmed(appPool, store, wrongPayloadCurrencyOrder);

  const wrongProviderCurrencyOrder = await nextOrder('provider-currency-mismatch');
  const wrongProviderCurrencyPayment = 'pay_phase6providercurrency';
  providerResults.set(wrongProviderCurrencyPayment, { body: {
    id: wrongProviderCurrencyPayment, order_id: wrongProviderCurrencyOrder.razorpayOrderId,
    amount: Math.round(wrongProviderCurrencyOrder.subtotalNumeric * 100), currency: 'USD', status: 'captured'
  } });
  const wrongProviderCurrencyResult = await sendWebhook(
    eventFor(wrongProviderCurrencyOrder, wrongProviderCurrencyPayment), 'evt-phase6-provider-currency'
  );
  assert.equal(wrongProviderCurrencyResult.response.status, 400);
  await assertUnconfirmed(appPool, store, wrongProviderCurrencyOrder);

  for (const failure of [
    { status: 503, body: { error: 'temporary provider failure' } },
    { throw: new Error('simulated network error') }
  ]) {
    const order = await nextOrder('provider-api-failure');
    const paymentId = `pay_phase6failure${candidateIndex}`;
    providerResults.set(paymentId, failure);
    const result = await sendWebhook(eventFor(order, paymentId), `evt-phase6-provider-failure-${candidateIndex}`);
    assert.equal(result.response.status, 503);
    assert.doesNotMatch(JSON.stringify(result.body), /secret|stack|simulated network/i);
    await assertUnconfirmed(appPool, store, order);
  }

  const missingStatusOrder = await nextOrder('missing-status');
  const missingStatusEvent = eventFor(missingStatusOrder, 'pay_phase6missingstatus');
  delete missingStatusEvent.payload.payment.entity.status;
  const missingStatusResult = await sendWebhook(missingStatusEvent, 'evt-phase6-missing-status');
  assert.equal(missingStatusResult.response.status, 400);
  await assertUnconfirmed(appPool, store, missingStatusOrder);

  console.log('PostgreSQL payment-webhook provider verification integration tests passed.');
} finally {
  if (server?.listening) await new Promise(resolve => server.close(resolve));
  await closeStore().catch(() => {});
  if (appPool) await appPool.end();
  await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
  await adminPool.end();
  globalThis.fetch = originalFetch;
  for (const [name, value] of Object.entries(originalEnv)) setEnv(name, value);
}
