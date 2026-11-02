import { chromium } from 'playwright';
import { startServer } from '../server.js';

async function testComplete() {
  let server = null;
  try {
    server = await startServer(3000);
    console.log('[TEST] Started local server on http://localhost:3000');
  } catch (err) {
    console.log('[TEST] Server port 3000 already running or bound:', err.message);
  }

  const browser = await chromium.launch({ headless: true });
  const browserContext = await browser.newContext();
  const page = await browserContext.newPage();

  const failedRequests = [];
  const consoleErrors = [];
  let expectedUnavailableOrder404ConsoleError = false;

  const watchBrowserPage = target => {
    target.on('console', msg => {
      if (msg.type() === 'error') {
        const expectedUnavailableOrder404 = expectedUnavailableOrder404ConsoleError &&
          /Failed to load resource: the server responded with a status of 404/i.test(msg.text());
        if (expectedUnavailableOrder404) {
          expectedUnavailableOrder404ConsoleError = false;
        } else {
          consoleErrors.push(msg.text());
        }
      }
      console.log(`[BROWSER ${msg.type().toUpperCase()}]:`, msg.text());
    });

    target.on('requestfailed', req => {
      if (!req.url().includes('google-analytics') && !req.url().includes('googletagmanager')) {
        failedRequests.push({ url: req.url(), error: req.failure()?.errorText });
        console.log(`[REQ FAILED]: ${req.url()} (${req.failure()?.errorText})`);
      }
    });

    target.on('response', res => {
      const expectedMissingOrder = res.status() === 404 &&
        /\/api\/checkout\/order-status\?orderId=ORD-BROWSER-MISSING(?:&|$)/.test(res.url());
      if (expectedMissingOrder) expectedUnavailableOrder404ConsoleError = true;
      if (res.status() >= 400 && !expectedMissingOrder && !res.url().includes('google-analytics') && !res.url().includes('googletagmanager')) {
        failedRequests.push({ url: res.url(), status: res.status() });
        console.log(`[NET ERROR]: ${res.status()} ${res.url()}`);
      }
    });
  };
  watchBrowserPage(page);

  try {
    console.log('\n--- 1. Testing paintings.html ---');
    await page.goto('http://localhost:3000/paintings.html', { waitUntil: 'networkidle' });

    // Clear cart
    await page.evaluate(() => localStorage.removeItem('shweta_studio_cart_v1'));

    const testPaintings = ['SS-PT-006', 'SS-PT-008', 'SS-PT-013', 'SS-PT-014', 'SS-PT-001'];
    for (const sku of testPaintings) {
      console.log(`\nTesting Add to Bag for ${sku}...`);
      const btn = page.locator(`button[onclick*="${sku}"][onclick*="handleCardAddToCart"]`).first();
      if (await btn.count() === 0) {
        throw new Error(`Button for ${sku} not found on paintings.html!`);
      }

      await btn.click();
      await page.waitForTimeout(1000);

      // Check toast
      const toast = page.locator('#studio-toast');
      const toastText = (await toast.count() > 0) ? await toast.innerText() : '';
      console.log(`Toast for ${sku}: "${toastText.replace(/\n/g, ' ')}"`);

      if (toastText.includes('Unable to verify') || toastText.includes('error') || toastText.includes('Error')) {
        throw new Error(`Verification error toast detected for ${sku}: "${toastText}"`);
      }

      // Check cart drawer
      const drawerOpen = await page.evaluate(() => {
        const d = document.getElementById('studio-cart-drawer-backdrop');
        return d ? d.classList.contains('is-open') : false;
      });
      if (!drawerOpen) {
        throw new Error(`Cart drawer failed to open after adding ${sku}!`);
      }

      // Close drawer
      await page.evaluate(() => window.closeCartDrawer && window.closeCartDrawer());
      await page.waitForTimeout(500);
    }

    console.log('\n--- 2. Testing sculptures.html ---');
    await page.goto('http://localhost:3000/sculptures.html', { waitUntil: 'networkidle' });

    // SS-SC-002: Available sculpture
    console.log('Testing SS-SC-002 (Available)...');
    const btnSC002 = page.locator('button[onclick*="SS-SC-002"][onclick*="handleCardAddToCart"]').first();
    await btnSC002.click();
    await page.waitForTimeout(1000);
    const toastSC002 = page.locator('#studio-toast');
    const textSC002 = (await toastSC002.count() > 0) ? await toastSC002.innerText() : '';
    console.log(`Toast for SS-SC-002: "${textSC002.replace(/\n/g, ' ')}"`);
    if (textSC002.includes('Unable to verify')) {
      throw new Error(`Verification error on SS-SC-002: "${textSC002}"`);
    }
    await page.evaluate(() => window.closeCartDrawer && window.closeCartDrawer());
    await page.waitForTimeout(500);

    // SS-SC-004: Reserved piece must NOT have Add to Bag button
    console.log('Testing SS-SC-004 (Reserved piece)...');
    const btnSC004 = page.locator('button[onclick*="SS-SC-004"][onclick*="handleCardAddToCart"]');
    const countSC004 = await btnSC004.count();
    console.log(`SS-SC-004 Add to Bag button count: ${countSC004} (expected 0)`);
    if (countSC004 > 0) {
      throw new Error('Reserved piece SS-SC-004 has an Add to Bag button!');
    }

    // SS-SC-001: Inquiry only piece must NOT have Add to Bag button
    console.log('Testing SS-SC-001 (Inquiry only piece)...');
    const btnSC001 = page.locator('button[onclick*="SS-SC-001"][onclick*="handleCardAddToCart"]');
    const countSC001 = await btnSC001.count();
    console.log(`SS-SC-001 Add to Bag button count: ${countSC001} (expected 0)`);
    if (countSC001 > 0) {
      throw new Error('Inquiry-only piece SS-SC-001 has an Add to Bag button!');
    }

    console.log('\n--- 3. Testing jewellery.html ---');
    await page.goto('http://localhost:3000/jewellery.html', { waitUntil: 'networkidle' });
    console.log('Testing SS-JW-001 (Jewellery)...');
    const btnJW001 = page.locator('button[onclick*="SS-JW-001"][onclick*="handleCardAddToCart"]').first();
    await btnJW001.click();
    await page.waitForTimeout(1000);
    const toastJW001 = page.locator('#studio-toast');
    const textJW001 = (await toastJW001.count() > 0) ? await toastJW001.innerText() : '';
    console.log(`Toast for SS-JW-001: "${textJW001.replace(/\n/g, ' ')}"`);
    if (textJW001.includes('Unable to verify')) {
      throw new Error(`Verification error on SS-JW-001: "${textJW001}"`);
    }

    console.log('\n--- 4. Checking Cart Drawer Thumbnails ---');
    const thumbs = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('.cart-item-thumb')).map(img => ({
        src: img.getAttribute('src'),
        currentSrc: img.currentSrc,
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight,
        complete: img.complete
      }));
    });
    console.log('Cart drawer thumbnails:', JSON.stringify(thumbs, null, 2));
    for (const thumb of thumbs) {
      if (!thumb.complete || thumb.naturalWidth <= 0 || thumb.naturalHeight <= 0) {
        throw new Error(`Cart thumbnail failed to load visibly: ${JSON.stringify(thumb)}`);
      }
    }
    console.log(`All ${thumbs.length} cart drawer thumbnails loaded visibly with non-zero dimensions!`);

    await page.evaluate(() => window.closeCartDrawer && window.closeCartDrawer());
    await page.waitForTimeout(500);

    console.log('\n--- 5. Checking cart.html page ---');
    await page.goto('http://localhost:3000/cart.html', { waitUntil: 'networkidle' });
    const cartPageThumbs = await page.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll('.cart-item-card img, div[style*="grid-template-columns: 88px"] img'));
      return imgs.map(img => ({
        src: img.getAttribute('src'),
        currentSrc: img.currentSrc,
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight,
        complete: img.complete
      }));
    });
    console.log(`cart.html thumbnails count: ${cartPageThumbs.length}`);
    for (const thumb of cartPageThumbs) {
      if (!thumb.complete || thumb.naturalWidth <= 0 || thumb.naturalHeight <= 0) {
        throw new Error(`cart.html thumbnail failed to load visibly: ${JSON.stringify(thumb)}`);
      }
    }
    console.log(`All ${cartPageThumbs.length} cart.html thumbnails loaded visibly!`);

    console.log('\n--- 6. Testing checkout cancellation and demo completion ---');
    await page.goto('http://localhost:3000/checkout.html', { waitUntil: 'networkidle' });
    const checkoutForm = page.locator('#checkout-form');
    if (await checkoutForm.count() === 0) {
      throw new Error('Checkout form did not load for the populated cart.');
    }

    const customer = {
      name: 'Browser Regression',
      email: 'browser-regression@example.test',
      phone: '+919876543210',
      address: '10 Test Street',
      city: 'Agra',
      state: 'Uttar Pradesh',
      postalCode: '282001'
    };
    for (const [field, value] of Object.entries(customer)) {
      await page.locator(`#checkout-form [name="${field}"]`).fill(value);
    }

    // Wrap the real demo order response with a test Razorpay order ID, then
    // simulate closing the payment modal to exercise the actual cancel route.
    await page.route('**/api/checkout/create-order', async route => {
      const response = await route.fetch();
      const data = await response.json();
      if (!response.ok || !data.order?.orderId) {
        await route.fulfill({ response, json: data });
        return;
      }
      if (Object.hasOwn(data.order, 'customer')) {
        throw new Error('Public checkout response exposed customer details.');
      }
      await route.fulfill({
        response,
        json: { ...data, razorpayOrderId: 'order_test_browser_cancel', keyId: 'rzp_test_browser' }
      });
    });
    await page.evaluate(() => {
      window.Razorpay = function (options) {
        window.__testRazorpayPrefill = options.prefill;
        this.open = () => options.modal.ondismiss();
      };
    });
    const cancellationResponsePromise = page.waitForResponse(
      response => response.url().endsWith('/api/checkout/cancel-order'),
      { timeout: 15000 }
    );
    await page.locator('#btn-submit-order').click();
    const cancellationResponse = await cancellationResponsePromise;
    if (!cancellationResponse.ok()) {
      throw new Error(`Payment cancellation API returned HTTP ${cancellationResponse.status()}.`);
    }
    await page.locator('#checkout-status-message').getByText(/Payment window was closed/i).waitFor();
    const gatewayPrefill = await page.evaluate(() => window.__testRazorpayPrefill);
    if (gatewayPrefill.name !== customer.name || gatewayPrefill.email !== customer.email || gatewayPrefill.contact !== customer.phone) {
      throw new Error('Razorpay prefill did not use the checkout form details.');
    }
    await page.unroute('**/api/checkout/create-order');

    // A retryable provider verification response must lead to a neutral
    // pending state, never a false signature failure or confirmed receipt.
    const retryablePaymentPage = await browserContext.newPage();
    watchBrowserPage(retryablePaymentPage);
    await retryablePaymentPage.route('**/api/checkout/create-order', async route => {
      const response = await route.fetch();
      const data = await response.json();
      await route.fulfill({ response, json: {
        ...data, razorpayOrderId: 'order_test_browser_pending', keyId: 'rzp_test_browser'
      } });
    });
    await retryablePaymentPage.route('**/api/checkout/verify-payment', route => route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ success: false, retryable: true, error: 'Payment verification is temporarily unavailable.' })
    }));
    await retryablePaymentPage.route('**/api/checkout/order-status**', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, status: 'payment_pending' })
    }));
    await retryablePaymentPage.goto('http://localhost:3000/checkout.html', { waitUntil: 'networkidle' });
    await retryablePaymentPage.evaluate(() => {
      window.Razorpay = function (options) {
        this.open = () => options.handler({
          razorpay_order_id: 'order_test_browser_pending',
          razorpay_payment_id: 'pay_test_browser_pending',
          razorpay_signature: 'a'.repeat(64)
        });
      };
    });
    for (const [field, value] of Object.entries(customer)) {
      await retryablePaymentPage.locator(`#checkout-form [name="${field}"]`).fill(value);
    }
    await retryablePaymentPage.locator('#btn-submit-order').click();
    await retryablePaymentPage.getByRole('heading', { name: 'Payment Pending' }).waitFor();
    if (await retryablePaymentPage.locator('#confirm-receipt').isVisible()) {
      throw new Error('Retryable payment verification incorrectly displayed a confirmed receipt.');
    }
    const pendingCopy = await retryablePaymentPage.locator('#confirm-status-description').innerText();
    if (!/Do not submit another payment/i.test(pendingCopy)) {
      throw new Error('Pending payment state did not instruct the customer to avoid a duplicate payment.');
    }
    await retryablePaymentPage.close();

    // Finish checkout in a second tab in the same browser context. Keeping the
    // cancellation tab alive lets Chromium finish any remaining modal requests.
    const checkoutSuccessPage = await browserContext.newPage();
    watchBrowserPage(checkoutSuccessPage);
    // The retryable verification case intentionally leaves its real synthetic
    // checkout hold active. Use a different artwork for the independent demo
    // checkout so this browser regression does not compete with that hold.
    await checkoutSuccessPage.goto('http://localhost:3000/paintings.html', { waitUntil: 'networkidle' });
    await checkoutSuccessPage.evaluate(() => localStorage.removeItem('shweta_studio_cart_v1'));
    const isolatedArtworkButton = checkoutSuccessPage.locator('button[onclick*="SS-PT-002"][onclick*="handleCardAddToCart"]').first();
    if (await isolatedArtworkButton.count() === 0) {
      throw new Error('Independent demo checkout artwork SS-PT-002 was not available in the browser fixture.');
    }
    await isolatedArtworkButton.click();
    await checkoutSuccessPage.goto('http://localhost:3000/checkout.html', { waitUntil: 'networkidle' });
    for (const [field, value] of Object.entries(customer)) {
      await checkoutSuccessPage.locator(`#checkout-form [name="${field}"]`).fill(value);
    }
    await checkoutSuccessPage.locator('#btn-submit-order').click();
    await checkoutSuccessPage.getByRole('heading', { name: 'Test Checkout' }).waitFor();
    const confirmationUrl = new URL(checkoutSuccessPage.url());
    if (!confirmationUrl.pathname.endsWith('/order-confirmation.html') || confirmationUrl.search) {
      throw new Error('Demo checkout did not reach confirmation with the order reference removed from browser history.');
    }
    if (await checkoutSuccessPage.locator('#confirm-receipt').isVisible()) {
      throw new Error('A simulated checkout incorrectly displayed the confirmed receipt.');
    }
    console.log('Checkout created a demo order, handled payment-window cancellation, and displayed the non-paid test state.');

    const confirmationCases = [
      ['confirmed', 'Acquisition Confirmed', true],
      ['payment_pending', 'Payment Pending', false],
      ['failed', 'Payment Not Completed', false],
      ['cancelled', 'Checkout Cancelled', false],
      ['expired', 'Reservation Expired', false],
      ['demo_simulated', 'Test Checkout', false],
      ['unrecognized', 'Confirmation Unavailable', false]
    ];
    let confirmationResponse = { status: 200, body: { success: true, status: '' } };
    await checkoutSuccessPage.route('**/api/checkout/order-status**', route => route.fulfill({
      status: confirmationResponse.status,
      contentType: 'application/json',
      body: JSON.stringify(confirmationResponse.body)
    }));
    for (const [status, expectedTitle, receiptVisible] of confirmationCases) {
      confirmationResponse = { status: 200, body: { success: true, status } };
      await checkoutSuccessPage.goto(`http://localhost:3000/order-confirmation.html?orderId=ORD-BROWSER-${status}`, { waitUntil: 'networkidle' });
      await checkoutSuccessPage.getByRole('heading', { name: expectedTitle }).waitFor();
      if ((await checkoutSuccessPage.locator('#confirm-receipt').isVisible()) !== receiptVisible) {
        throw new Error(`Receipt visibility was incorrect for confirmation state ${status}.`);
      }
      if (receiptVisible) {
        const labels = await checkoutSuccessPage.locator('#confirm-receipt').innerText();
        if (!labels.includes('Valued Art Collector') || !labels.includes('Provided at checkout') || /Insured Delivery Destination/i.test(labels)) {
          throw new Error('Confirmed receipt exposed customer data or included an unverified insurance claim.');
        }
      }
    }
    confirmationResponse = { status: 404, body: { success: false, error: 'Order status is unavailable.' } };
    expectedUnavailableOrder404ConsoleError = false;
    await checkoutSuccessPage.goto('http://localhost:3000/order-confirmation.html?orderId=ORD-BROWSER-MISSING', { waitUntil: 'networkidle' });
    await checkoutSuccessPage.getByRole('heading', { name: 'Order Not Available' }).waitFor();
    if (await checkoutSuccessPage.locator('#confirm-receipt').isVisible()) {
      throw new Error('An inaccessible order incorrectly displayed the confirmed receipt.');
    }
    await checkoutSuccessPage.unroute('**/api/checkout/order-status**');
    await checkoutSuccessPage.goto('http://localhost:3000/order-confirmation.html', { waitUntil: 'networkidle' });
    await checkoutSuccessPage.getByRole('heading', { name: 'Order Not Available' }).waitFor();
    if (await checkoutSuccessPage.locator('#confirm-receipt').isVisible()) {
      throw new Error('A confirmation page without an order reference displayed a receipt.');
    }

    console.log('\n--- 7. Checking errors summary ---');
    console.log('Failed network requests:', failedRequests);
    console.log('Browser console errors:', consoleErrors);

    if (failedRequests.length > 0) {
      throw new Error(`Found ${failedRequests.length} failed network requests!`);
    }
    if (consoleErrors.length > 0) {
      throw new Error(`Found ${consoleErrors.length} browser console errors!`);
    }

    console.log('\n========================================');
    console.log('ALL VERIFICATION AND IMAGE TESTS PASSED!');
    console.log('========================================');
  } finally {
    await browser.close();
    if (server) {
      server.close();
      console.log('[TEST] Server closed.');
    }
  }
}

testComplete().catch(err => {
  console.error('[TEST SUITE FATAL ERROR]:', err);
  process.exit(1);
});
