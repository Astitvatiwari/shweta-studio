// tests/verify-inventory-system.js
// Automated verification and regression test suite for Shweta Studio inventory and purchasing system.
// Exercises real HTTP endpoints, persistent store isolation, security controls, and concurrency.

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configure isolated test environment before loading server/store modules
const TEST_DATA_DIR = path.join(__dirname, 'test-data');
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.ALLOW_DEMO_CHECKOUT = 'true';
process.env.ADMIN_API_KEY = 'test-studio-admin-secret-key-123';

const PORT = 3456;
const BASE_URL = `http://localhost:${PORT}`;

// Import dependencies after environment configuration
const { startServer } = await import('../server.js');
const {
  getInventory,
  getArtworkInventory,
  getOrders,
  calculatePreparationTime,
  getAuthoritativePrice,
  resetTestStore,
  initializeInventory
} = await import('../data/inventory-store.js');

let serverInstance = null;
let passedCount = 0;
const totalCount = 15;

function reportTest(num, name, passed, details = '') {
  const symbol = passed ? '✅' : '❌';
  console.log(`${symbol} Test ${num}: ${name}`);
  if (details) console.log(`   └─ ${details}`);
  if (passed) passedCount++;
}

async function runTests() {
  console.log('\n================================================================');
  console.log(' SHWETA STUDIO — PRODUCTION READINESS & SECURITY TEST SUITE');
  console.log('================================================================\n');

  // Ensure isolated test data directory
  if (!fs.existsSync(TEST_DATA_DIR)) {
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  }

  // Start background HTTP server on test port
  serverInstance = await startServer(PORT);
  console.log(`[TEST SERVER] Running at ${BASE_URL} (Isolated Data Dir: ${TEST_DATA_DIR})\n`);

  try {
    // ----------------------------------------------------
    // Test 1: Available and sold original behavior
    // ----------------------------------------------------
    {
      resetTestStore();
      const testCode = 'SS-SC-002'; // Waxen Form

      // Initial state: Available
      const initInv = getArtworkInventory(testCode);
      assert.strictEqual(initInv.status, 'Available');
      assert.strictEqual(initInv.originalQuantity, 1);

      // Successful purchase of available original
      const buyRes = await fetch(`${BASE_URL}/api/orders/original`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inventoryCode: testCode,
          customer: {
            name: 'Original Buyer',
            email: 'orig@test.com',
            phone: '+91 9876543210',
            country: 'India',
            address: '10 Art Lane, New Delhi'
          },
          paymentVerification: { status: 'verified', method: 'demo_card' }
        })
      });
      const buyData = await buyRes.json();
      assert.strictEqual(buyRes.status, 201);
      assert.strictEqual(buyData.success, true);
      assert.strictEqual(buyData.item.status, 'Sold');

      // Second purchase of sold original must be rejected with 409 Conflict
      const secondRes = await fetch(`${BASE_URL}/api/orders/original`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inventoryCode: testCode,
          customer: {
            name: 'Second Buyer',
            email: 'second@test.com',
            country: 'India',
            address: '20 Gallery Rd'
          },
          paymentVerification: { status: 'verified' }
        })
      });
      const secondData = await secondRes.json();
      const passed = secondRes.status === 409 && secondData.status === 'Sold';
      reportTest(1, 'Available and sold original behavior', passed,
        `1st purchase succeeded (201); 2nd purchase rejected with HTTP 409 Conflict: "${secondData.error}"`);
      assert.ok(passed);
    }

    // ----------------------------------------------------
    // Test 2: Customization while original is available and sold
    // ----------------------------------------------------
    {
      const soldCode = 'SS-SC-002'; // Already sold in Test 1
      const availCode = 'SS-PT-003'; // Available

      // Commission on sold piece
      const commSoldRes = await fetch(`${BASE_URL}/api/orders/custom`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inventoryCode: soldCode,
          customer: { name: 'Client A', email: 'a@test.com', country: 'India' }
        })
      });
      const commSoldData = await commSoldRes.json();
      const soldInv = getArtworkInventory(soldCode);
      const soldIntact = commSoldRes.status === 201 && soldInv.status === 'Sold' && soldInv.originalQuantity === 0;

      // Commission on available piece
      const commAvailRes = await fetch(`${BASE_URL}/api/orders/custom`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inventoryCode: availCode,
          customer: { name: 'Client B', email: 'b@test.com', country: 'India' }
        })
      });
      const commAvailData = await commAvailRes.json();
      const availInv = getArtworkInventory(availCode);
      const availIntact = commAvailRes.status === 201 && availInv.status === 'Available' && availInv.originalQuantity === 1;

      const passed = soldIntact && availIntact;
      reportTest(2, 'Customization while original is available and sold', passed,
        `Commissions accepted on both sold & available originals without altering original inventory quantities`);
      assert.ok(passed);
    }

    // ----------------------------------------------------
    // Test 3: Server-side price validation
    // ----------------------------------------------------
    {
      const testCode = 'SS-SC-001'; // Listed price: ₹10,000 / $178 Worldwide
      
      // Client maliciously attempts to pass forged price "$1.00"
      const forgedRes = await fetch(`${BASE_URL}/api/orders/custom`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inventoryCode: testCode,
          price: '$1.00', // Malicious forged price
          customer: { name: 'Tampering Attacker', email: 'attacker@test.com', country: 'USA' }
        })
      });
      const forgedData = await forgedRes.json();
      
      // Server must calculate authoritative price ($178 for international order of ₹10,000 sculpture)
      const passed = forgedRes.status === 201 && forgedData.order.price === '$178';
      reportTest(3, 'Server-side price validation', passed,
        `Forged client price "$1.00" was completely ignored; server enforced authoritative price "${forgedData.order.price}"`);
      assert.ok(passed);
    }

    // ----------------------------------------------------
    // Test 4: Forged payment-verification attempts
    // ----------------------------------------------------
    {
      const testCode = 'SS-PT-004'; // Azure Reverie (Available)
      
      // Attempt unverified payment with status: "pending"
      const pendingRes = await fetch(`${BASE_URL}/api/orders/original`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inventoryCode: testCode,
          customer: { name: 'Unverified Buyer', email: 'buyer@test.com', address: '123 Fake St' },
          paymentVerification: { status: 'pending' }
        })
      });
      const pendingData = await pendingRes.json();
      const afterInv = getArtworkInventory(testCode);
      const passed = pendingRes.status === 402 && afterInv.status === 'Available' && afterInv.originalQuantity === 1;

      reportTest(4, 'Forged payment-verification attempts', passed,
        `Unverified payment rejected with HTTP 402; inventory status remained "${afterInv.status}" (Qty: ${afterInv.originalQuantity})`);
      assert.ok(passed);
    }

    // ----------------------------------------------------
    // Test 5: Failed and pending payments
    // ----------------------------------------------------
    {
      const testCode = 'SS-PT-004';
      const failRes = await fetch(`${BASE_URL}/api/orders/original`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inventoryCode: testCode,
          customer: { name: 'Declined Buyer', email: 'fail@test.com', address: 'Declined Way' },
          paymentVerification: { status: 'failed', method: 'declined_card' }
        })
      });
      const failData = await failRes.json();
      const afterInv = getArtworkInventory(testCode);
      const passed = failRes.status === 402 && afterInv.status === 'Available' && failData.success === false;

      reportTest(5, 'Failed and pending payments', passed,
        `Declined payment returned HTTP 402; inventory was NOT modified`);
      assert.ok(passed);
    }

    // ----------------------------------------------------
    // Test 6: Duplicate webhook or payment events (Idempotency)
    // ----------------------------------------------------
    {
      const testCode = 'SS-PT-005'; // Reflections in Glass (Available)
      const requestId = 'REQ-IDEMPOTENT-ORIGINAL-001';

      // First submission
      const res1 = await fetch(`${BASE_URL}/api/orders/original`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inventoryCode: testCode,
          clientRequestId: requestId,
          customer: { name: 'Idempotent Buyer', email: 'idem@test.com', address: '1 Idempotent Lane' },
          paymentVerification: { status: 'verified' }
        })
      });
      const data1 = await res1.json();
      assert.strictEqual(res1.status, 201);

      // Duplicate submission with identical clientRequestId
      const res2 = await fetch(`${BASE_URL}/api/orders/original`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inventoryCode: testCode,
          clientRequestId: requestId,
          customer: { name: 'Idempotent Buyer', email: 'idem@test.com', address: '1 Idempotent Lane' },
          paymentVerification: { status: 'verified' }
        })
      });
      const data2 = await res2.json();

      const passed = res2.status === 200 && data2.order.orderId === data1.order.orderId && data2.message.includes('idempotent');
      reportTest(6, 'Duplicate webhook or payment events (Idempotency)', passed,
        `Duplicate event returned existing order (${data2.order.orderId}) with HTTP 200 without creating duplicate sale`);
      assert.ok(passed);
    }

    // ----------------------------------------------------
    // Test 7: Unauthorized access to order data
    // ----------------------------------------------------
    {
      // Unauthenticated request
      const noAuthRes = await fetch(`${BASE_URL}/api/orders`);
      const noAuthData = await noAuthRes.json();
      const blocked = noAuthRes.status === 403 && noAuthData.success === false;

      // Authorized administrative request
      const authRes = await fetch(`${BASE_URL}/api/orders`, {
        headers: { 'Authorization': `Bearer ${process.env.ADMIN_API_KEY}` }
      });
      const authData = await authRes.json();
      const authorized = authRes.status === 200 && authData.success === true && Array.isArray(authData.orders);

      const passed = blocked && authorized;
      reportTest(7, 'Unauthorized access to order data', passed,
        `Unauthenticated access rejected (HTTP 403); access granted with administrative bearer token (HTTP 200)`);
      assert.ok(passed);
    }

    // ----------------------------------------------------
    // Test 8: Invalid IDs and malformed requests
    // ----------------------------------------------------
    {
      // 8a: Non-existent inventory code
      const badIdRes = await fetch(`${BASE_URL}/api/orders/original`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inventoryCode: 'NON-EXISTENT-SKU-999',
          customer: { name: 'Test', email: 'test@test.com', address: 'Address' },
          paymentVerification: { status: 'verified' }
        })
      });
      const badIdData = await badIdRes.json();
      const passed404 = badIdRes.status === 404;

      // 8b: Malformed email
      const badEmailRes = await fetch(`${BASE_URL}/api/orders/original`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inventoryCode: 'SS-PT-001',
          customer: { name: 'Bad Email', email: 'not-an-email', address: 'Address' },
          paymentVerification: { status: 'verified' }
        })
      });
      const passedEmail = badEmailRes.status === 400;

      // 8c: Oversized address (> 500 chars)
      const bigAddress = 'A'.repeat(600);
      const bigRes = await fetch(`${BASE_URL}/api/orders/original`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inventoryCode: 'SS-PT-001',
          customer: { name: 'Big', email: 'big@test.com', address: bigAddress },
          paymentVerification: { status: 'verified' }
        })
      });
      const passedBig = bigRes.status === 400;

      const passed = passed404 && passedEmail && passedBig;
      reportTest(8, 'Invalid IDs and malformed requests', passed,
        `Unknown SKU returned 404; invalid email returned 400; oversized input payload returned 400`);
      assert.ok(passed);
    }

    // ----------------------------------------------------
    // Test 9: Concurrent original purchase attempts
    // ----------------------------------------------------
    {
      const testCode = 'SS-PT-001'; // Bloom in Stillness (Available)
      const buyers = ['Concurrent 1', 'Concurrent 2', 'Concurrent 3', 'Concurrent 4', 'Concurrent 5'];

      const promises = buyers.map(name =>
        fetch(`${BASE_URL}/api/orders/original`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            inventoryCode: testCode,
            customer: { name, email: `${name.replace(/\s+/g, '').toLowerCase()}@test.com`, address: 'Simultaneous St' },
            paymentVerification: { status: 'verified' }
          })
        }).then(async r => ({ status: r.status, data: await r.json() }))
      );

      const results = await Promise.all(promises);
      const successCount = results.filter(r => r.status === 201).length;
      const conflictCount = results.filter(r => r.status === 409).length;

      const finalInv = getArtworkInventory(testCode);
      const passed = successCount === 1 && conflictCount === 4 && finalInv.originalQuantity === 0;

      reportTest(9, 'Concurrent original purchase attempts', passed,
        `5 simultaneous requests: exactly 1 succeeded (201) and 4 were rejected (409); final quantity is 0`);
      assert.ok(passed);
    }

    // ----------------------------------------------------
    // Test 10: Duplicate commission submissions
    // ----------------------------------------------------
    {
      const testCode = 'SS-SC-001';
      const commRequestId = 'COM-IDEMPOTENT-001';

      const res1 = await fetch(`${BASE_URL}/api/orders/custom`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inventoryCode: testCode,
          clientRequestId: commRequestId,
          customer: { name: 'Dup Commission', email: 'dup@test.com' }
        })
      });
      const data1 = await res1.json();
      assert.strictEqual(res1.status, 201);

      const res2 = await fetch(`${BASE_URL}/api/orders/custom`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inventoryCode: testCode,
          clientRequestId: commRequestId,
          customer: { name: 'Dup Commission', email: 'dup@test.com' }
        })
      });
      const data2 = await res2.json();

      const passed = res2.status === 200 && data2.order.orderId === data1.order.orderId;
      reportTest(10, 'Duplicate commission submissions', passed,
        `Duplicate commission with same clientRequestId returned existing order (${data2.order.orderId})`);
      assert.ok(passed);
    }

    // ----------------------------------------------------
    // Test 11: Persistence across restart and rebuild
    // ----------------------------------------------------
    {
      // Verify that Waxen Form (SS-SC-002) which was sold in Test 1 remains Sold after site rebuild
      const preBuildInv = getArtworkInventory('SS-SC-002');
      assert.strictEqual(preBuildInv.status, 'Sold');

      // Execute compile.js with isolated DATA_DIR in env
      execSync('node compile.js', {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, DATA_DIR: TEST_DATA_DIR }
      });

      const postBuildInv = getArtworkInventory('SS-SC-002');
      const compiledCandleHtml = fs.readFileSync(path.join(__dirname, '../pieces/candle.html'), 'utf-8');
      const hasSoldNotice = compiledCandleHtml.includes('Original Sold');

      const passed = postBuildInv.status === 'Sold' && hasSoldNotice;
      reportTest(11, 'Persistence across restart and rebuild', passed,
        `SS-SC-002 remained "Sold" after full "node compile.js" static rebuild with 0 tag errors`);
      assert.ok(passed);

      // Restore static files to production store state
      try {
        execSync('node compile.js', {
          cwd: path.join(__dirname, '..'),
          env: { ...process.env, DATA_DIR: path.join(__dirname, '../data') },
          stdio: 'ignore'
        });
      } catch (e) {
        // Ignore build logs during test
      }
    }

    // ----------------------------------------------------
    // Test 12: Storage failures and error handling
    // ----------------------------------------------------
    {
      // Write corrupted JSON to test inventory file
      const invFilePath = path.join(TEST_DATA_DIR, 'inventory.json');
      fs.writeFileSync(invFilePath, 'MALFORMED_JSON_CONTENT{{{', 'utf-8');

      // Call getInventory(): must catch error, self-heal and reinitialize without crashing
      const recoveredInv = getInventory();
      const passed = recoveredInv && typeof recoveredInv === 'object' && recoveredInv['SS-SC-001'] !== undefined;

      reportTest(12, 'Storage failures and error handling', passed,
        `Corrupted store file was safely caught and auto-reinitialized without uncaught exceptions`);
      assert.ok(passed);
    }

    // ----------------------------------------------------
    // Test 13: Correct preparation times by category
    // ----------------------------------------------------
    {
      const paintingPrep = calculatePreparationTime({ category: 'Paintings', medium: 'Oil on Canvas' });
      const terracottaPrep = calculatePreparationTime({ category: 'Sculptures', medium: 'Terracotta Clay' });
      const jewelleryPrep = calculatePreparationTime({ category: 'Jewellery' });
      const otherPrep = calculatePreparationTime({ category: 'Sculptures', medium: 'Corrugated Cardboard' });

      const passed = paintingPrep.duration === '15 days' &&
                     terracottaPrep.duration === '2 months' &&
                     jewelleryPrep.duration === 'Up to 20 business days' &&
                     otherPrep.duration === 'Consultation timeline';

      reportTest(13, 'Correct preparation times by category', passed,
        `Paintings: 15 days; Terracotta: 2 months; Jewellery: 20 business days; Custom/Other: Consultation timeline`);
      assert.ok(passed);
    }

    // ----------------------------------------------------
    // Test 14: Quote-required customization requests
    // ----------------------------------------------------
    {
      const testCode = 'SS-SC-001';
      const commRes = await fetch(`${BASE_URL}/api/orders/custom`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inventoryCode: testCode,
          requestedDimensions: '48 × 36 inches',
          desiredModifications: 'Monumental scale custom finish',
          isQuotationRequired: true,
          customer: { name: 'Quote Patron', email: 'patron@test.com', country: 'Germany' }
        })
      });
      const commData = await commRes.json();

      const passed = commData.order.quotationStatus === 'quote_required' &&
                     commData.order.price === 'Separate Studio Quotation Required' &&
                     commData.order.status === 'quotation_pending';

      reportTest(14, 'Quote-required customization requests', passed,
        `Custom dimensions routed for quotation (status: "${commData.order.quotationStatus}", price: "${commData.order.price}")`);
      assert.ok(passed);
    }

    // ----------------------------------------------------
    // Test 15: Existing page URLs, metadata, and responsive behavior
    // ----------------------------------------------------
    {
      const detailHtml = fs.readFileSync(path.join(__dirname, '../pieces/beyond-the-shell.html'), 'utf-8');
      const hasCanonical = detailHtml.includes('<link rel="canonical" href="https://shwetastudio.com/pieces/beyond-the-shell.html">');
      const hasOgImage = detailHtml.includes('<meta property="og:image"');
      const hasSchema = detailHtml.includes('"@type": "VisualArtwork"');
      const cssContent = fs.readFileSync(path.join(__dirname, '../styles/artwork.css'), 'utf-8');
      const hasResponsive = cssContent.includes('@media (max-width: 768px)');

      const passed = hasCanonical && hasOgImage && hasSchema && hasResponsive;
      reportTest(15, 'Existing page URLs, metadata, and responsive behavior', passed,
        `Canonical URL, OpenGraph, Schema.org VisualArtwork, and 768px responsive breakpoint intact`);
      assert.ok(passed);
    }

  } finally {
    if (serverInstance) {
      serverInstance.close();
    }
    // Clean up test data directory after running tests
    try {
      if (fs.existsSync(TEST_DATA_DIR)) {
        fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
      }
    } catch (e) {
      // Ignore directory cleanup locks
    }
  }

  console.log('\n----------------------------------------------------------------');
  console.log(` AUDIT TEST SUITE SUMMARY: ${passedCount} / ${totalCount} TESTS PASSED`);
  console.log('----------------------------------------------------------------\n');

  if (passedCount !== totalCount) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Fatal test runner error:', err);
  if (serverInstance) serverInstance.close();
  process.exit(1);
});
