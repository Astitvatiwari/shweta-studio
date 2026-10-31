import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shweta-gateway-test-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = testDir;
process.env.ALLOW_DEMO_CHECKOUT = 'false';
process.env.RAZORPAY_KEY_ID = 'rzp_test_synthetic';
process.env.RAZORPAY_KEY_SECRET = 'synthetic_secret_for_test_only';
process.env.RAZORPAY_API_URL = '';

const { startServer } = await import('../server.js');
const { getArtworkInventory, getOrders, resetTestStore } = await import('../data/inventory-store.js');
const server = await startServer(3478);
const realFetch = globalThis.fetch;
const originalConsoleError = console.error;
const capturedLogs = [];

try {
  await resetTestStore();
  const before = await getArtworkInventory('SS-PT-006');
  assert.equal(before.status, 'Available');
  assert.equal(before.originalQuantity, 1);

  globalThis.fetch = async (input, init) => {
    const url = new URL(input);
    if (url.hostname !== 'api.razorpay.com') return realFetch(input, init);
    assert.equal(url.href, 'https://api.razorpay.com/v1/orders');
    assert.equal(init.method, 'POST');
    assert.match(init.headers.Authorization, /^Basic /);
    assert.equal(Buffer.from(init.headers.Authorization.slice(6), 'base64').toString(),
      'rzp_test_synthetic:synthetic_secret_for_test_only', 'test key pair uses standard Basic Auth');
    const payload = JSON.parse(init.body);
    assert.ok(Number.isInteger(payload.amount) && payload.amount > 0);
    assert.equal(payload.currency, 'INR');
    const cause = Object.assign(new Error('synthetic DNS failure'), { code: 'ENOTFOUND' });
    throw new TypeError('fetch failed', { cause });
  };
  console.error = (...args) => capturedLogs.push(args.join(' '));

  const response = await realFetch('http://localhost:3478/api/checkout/create-order', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customer: {
        name: 'Synthetic Buyer', email: 'buyer@example.test', phone: '+919876543210',
        country: 'India', address: '10 Synthetic Road', city: 'Agra', state: 'Uttar Pradesh', postalCode: '282001'
      },
      items: [{ inventoryCode: 'SS-PT-006', purchaseType: 'original', quantity: 1 }],
      clientRequestId: 'synthetic-gateway-dns-test'
    })
  });
  const body = await response.json();
  assert.equal(response.status, 502);
  assert.match(body.error, /reservation released/i);

  const after = await getArtworkInventory('SS-PT-006');
  assert.equal(after.status, 'Available', 'failed gateway order releases its checkout hold');
  assert.equal(after.originalQuantity, 1);
  assert.equal(after.reservationType, null);
  const order = (await getOrders()).find(item => item.clientRequestId === 'synthetic-gateway-dns-test');
  assert.ok(order, 'failed gateway order remains persisted for audit');
  assert.equal(order.paymentStatus, 'cancelled');

  const log = capturedLogs.join('\n');
  assert.match(log, /category=dns status=none code=ENOTFOUND/);
  assert.doesNotMatch(log, /synthetic_secret_for_test_only|Synthetic Buyer|buyer@example\.test|Synthetic Road/);
  assert.doesNotMatch(JSON.stringify(body), /synthetic_secret_for_test_only|buyer@example\.test/);

  console.log('Razorpay gateway DNS diagnostics and reservation release checks passed.');
} finally {
  globalThis.fetch = realFetch;
  console.error = originalConsoleError;
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(testDir, { recursive: true, force: true });
}
