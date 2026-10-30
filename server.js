import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import artworks from './artworks.js';
import { safeAdminKeyMatch, safeClientError, verifyNetlifyProxySignature } from './security/request-security.js';
import {
  getSanitizedInventory,
  getSanitizedArtworkInventory,
  purchaseOriginal,
  commissionArtwork,
  getOrders,
  createCartOrder,
  quoteCart,
  updateOrderPaymentStatus,
  cancelCheckoutReservation,
  resetTestStore,
  updateRazorpayOrderId
} from './data/inventory-store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 3000;

const validInventoryCodes = new Set(artworks.map(a => a.inventoryCode.toUpperCase()));

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
};

// Rate limiter: Max 60 requests per minute per IP for API endpoints
const ipRequestHistory = new Map();

function checkRateLimit(ip) {
  const now = Date.now();
  const windowMs = 60 * 1000;
  const configuredLimit = Number.parseInt(process.env.API_RATE_LIMIT_PER_PROXY || (process.env.NODE_ENV === 'production' ? '600' : '60'), 10);
  const limit = Number.isInteger(configuredLimit) && configuredLimit > 0 ? configuredLimit : 60;

  let records = ipRequestHistory.get(ip) || [];
  records = records.filter(timestamp => now - timestamp < windowMs);

  if (records.length >= limit) {
    return false;
  }

  records.push(now);
  ipRequestHistory.set(ip, records);

  // Periodic garbage collection
  if (ipRequestHistory.size > 1000) {
    for (const [key, timestamps] of ipRequestHistory.entries()) {
      if (timestamps.length === 0 || now - timestamps[timestamps.length - 1] > windowMs) {
        ipRequestHistory.delete(key);
      }
    }
  }

  return true;
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let oversized = false;
    req.on('data', chunk => {
      if (oversized) return;
      body += chunk;
      if (body.length > 50000) {
        oversized = true;
        body = '';
        reject(safeClientError('Request payload exceeds permitted maximum size (50KB).', 413));
      }
    });
    req.on('end', () => {
      if (oversized) return;
      if (!body.trim()) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(safeClientError('Malformed JSON payload.'));
      }
    });
    req.on('error', reject);
  });
}

function parseRawBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let oversized = false;
    req.on('data', chunk => {
      if (oversized) return;
      raw += chunk;
      if (raw.length > 50000) {
        oversized = true;
        raw = '';
        reject(safeClientError('Request payload exceeds permitted maximum size (50KB).', 413));
      }
    });
    req.on('end', () => {
      if (oversized) return;
      resolve(raw);
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, data) {
  const jsonStr = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
  });
  res.end(jsonStr);
}

function allowedOrigins() {
  const configured = process.env.STOREFRONT_ORIGINS || 'https://shwetastudio.com';
  const values = configured.split(',').map(value => value.trim()).filter(Boolean);
  if (process.env.NODE_ENV === 'test') values.push(`http://localhost:${PORT}`);
  return new Set(values);
}

function applySecurityHeaders(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'self'; object-src 'none'; base-uri 'self'");
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  const origin = req.headers.origin;
  if (origin && allowedOrigins().has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  }
}

function handleRequestError(res, error) {
  if (res.headersSent) return res.destroy();
  if (error?.isSafeClientError) {
    return sendJson(res, error.statusCode || 400, { success: false, error: error.message });
  }
  const code = typeof error?.code === 'string' ? error.code : 'internal';
  console.error(`[API] Request failed (${code}).`);
  return sendJson(res, 500, { success: false, error: 'Unable to process the request right now. Please try again.' });
}

function publicOrder(order, { keepCustomerName = false } = {}) {
  if (!order || typeof order !== 'object') return order;
  const { customer, ...safe } = order;
  if (keepCustomerName && customer?.name) safe.customer = { name: customer.name };
  return safe;
}

/**
 * Validates customer contact and delivery details.
 */
function validateCustomer(customer, isOriginalOrder = false) {
  if (!customer || typeof customer !== 'object' || Array.isArray(customer)) {
    return 'Customer information object is required.';
  }

  const { name, email, phone, country, address, city, state, postalCode } = customer;

  if (!name || typeof name !== 'string' || name.trim().length === 0 || name.length > 100) {
    return 'Customer name is required and must not exceed 100 characters.';
  }

  if (!email || typeof email !== 'string' || email.length > 254) {
    return 'Customer email is required and must not exceed 254 characters.';
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email.trim())) {
    return 'Invalid email address format.';
  }

  const boundedText = [
    ['name', name, 100], ['email', email, 254], ['phone', phone, 30],
    ['country', country, 60], ['address', address, 500], ['city', city, 100],
    ['state', state, 100], ['postalCode', postalCode, 20]
  ];
  for (const [field, value, max] of boundedText) {
    if (value !== undefined && value !== null && (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value))) {
      return `Customer ${field} is invalid or too long.`;
    }
  }

  if (country && (typeof country !== 'string' || country.length > 60)) {
    return 'Country name must not exceed 60 characters.';
  }

  if (phone && (typeof phone !== 'string' || phone.length > 30)) {
    return 'Phone number must not exceed 30 characters.';
  }

  if (isOriginalOrder) {
    if (!address || typeof address !== 'string' || address.trim().length < 5 || address.length > 500) {
      return 'Delivery address is required for original artwork orders (5 to 500 characters).';
    }
  }

  return null;
}

/**
 * Validates artwork inventory code.
 */
function validateInventoryCode(code) {
  if (!code || typeof code !== 'string') {
    return 'inventoryCode is required.';
  }
  const clean = code.trim().toUpperCase();
  if (clean.length > 30 || !/^[A-Z0-9-]+$/.test(clean)) {
    return 'Invalid inventoryCode format.';
  }
  if (!validInventoryCodes.has(clean)) {
    return `Artwork inventory code "${clean}" not recognized in studio catalog.`;
  }
  return null;
}

function validateClientRequestId(value) {
  if (value == null || value === '') return null;
  return typeof value === 'string' && value.length <= 80 && /^[A-Za-z0-9:_-]+$/.test(value)
    ? null : 'clientRequestId has an invalid format.';
}

function validateCartItems(items, { quote = false } = {}) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 20) {
    return 'Cart must contain between 1 and 20 items.';
  }
  const originalCodes = new Set();
  for (const line of items) {
    if (!line || typeof line !== 'object' || Array.isArray(line)) return 'Each cart item must be an object.';
    const codeError = validateInventoryCode(line.inventoryCode);
    if (codeError) {
      if (quote && codeError.includes('not recognized')) {
        const code = String(line.inventoryCode || '').trim().toUpperCase();
        return `Unknown artwork code "${code}" in cart.`;
      }
      return codeError;
    }
    if (line.purchaseType !== undefined && !['original', 'commission', 'stocked'].includes(line.purchaseType)) return 'Invalid purchase type.';
    if (line.purchaseType === 'original') {
      const code = String(line.inventoryCode).trim().toUpperCase();
      if (originalCodes.has(code)) return `Original artwork ${code} can appear only once in a cart.`;
      originalCodes.add(code);
      if (line.quantity !== undefined && line.quantity !== null && String(line.quantity).trim() !== '' && Number(line.quantity) !== 1) {
        return 'An original artwork quantity must be 1.';
      }
    }
    if (line.quantity !== undefined && line.quantity !== null && String(line.quantity).trim() !== '') {
      const quantity = Number(line.quantity);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) return 'Invalid quantity: item quantity must be an integer from 1 to 20.';
    }
    for (const field of ['customDimensions', 'customModifications']) {
      if (line[field] !== undefined && (typeof line[field] !== 'string' || line[field].length > (field === 'customDimensions' ? 100 : 1000))) {
        return `Invalid ${field} value.`;
      }
    }
  }
  return null;
}

function serveStatic(req, res, pathname) {
  // Reject null-byte injection attempts
  if (pathname.includes('\0')) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    return res.end('400 Bad Request');
  }

  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('400 Bad Request');
  }
  const relativePath = decodedPath === '/' || decodedPath === '\\' ? 'index.html' : decodedPath.replace(/^[/\\]+/, '');
  const filePath = path.resolve(__dirname, relativePath);

  // Must stay inside the project root, including same-prefix sibling paths.
  if (filePath !== __dirname && !filePath.startsWith(`${__dirname}${path.sep}`)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('403 Forbidden');
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      // Check if .html can be appended
      if (!path.extname(filePath)) {
        const htmlFallback = `${filePath}.html`;
        if (fs.existsSync(htmlFallback)) {
          const content = fs.readFileSync(htmlFallback);
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'SAMEORIGIN',
            'Referrer-Policy': 'strict-origin-when-cross-origin'
          });
          return res.end(content);
        }
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('404 Not Found');
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN',
      'Referrer-Policy': 'strict-origin-when-cross-origin'
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

async function handleRequest(req, res) {
  applySecurityHeaders(req, res);
  // Handle CORS Preflight
  if (req.method === 'OPTIONS') {
    const origin = req.headers.origin;
    if (origin && !allowedOrigins().has(origin)) return sendJson(res, 403, { success: false, error: 'Origin is not allowed.' });
    res.writeHead(204);
    return res.end();
  }

  const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = reqUrl.pathname;
  const clientIp = req.socket.remoteAddress || '127.0.0.1';

  const origin = req.headers.origin;
  if (origin && !allowedOrigins().has(origin)) {
    return sendJson(res, 403, { success: false, error: 'Origin is not allowed.' });
  }

  const isPaymentWebhook = req.method === 'POST' && pathname === '/api/payment/webhook';
  if (process.env.NODE_ENV === 'production' && pathname.startsWith('/api/') && !isPaymentWebhook) {
    const proxySecret = process.env.NETLIFY_PROXY_SIGNING_SECRET;
    const validProxy = proxySecret && verifyNetlifyProxySignature(
      req.headers['x-nf-sign'], proxySecret, { expectedSiteUrl: process.env.NETLIFY_SITE_URL || '' }
    );
    if (!validProxy) return sendJson(res, 403, { success: false, error: 'Request could not be authenticated.' });
  }

  if (pathname.startsWith('/api/') && req.method === 'POST' && !isPaymentWebhook) {
    const contentType = req.headers['content-type'] || '';
    if (!/^application\/(?:json|[a-z0-9.+-]+\+json)(?:\s*;|$)/i.test(contentType)) {
      return sendJson(res, 415, { success: false, error: 'Content-Type must be application/json.' });
    }
  }

  if (req.method === 'GET' && pathname === '/healthz') {
    return sendJson(res, 200, { success: true, status: 'ok' });
  }

  // Rate limit API endpoints
  if (pathname.startsWith('/api/')) {
    if (!checkRateLimit(clientIp)) {
      return sendJson(res, 429, { success: false, error: 'Rate limit exceeded. Please try again shortly.' });
    }
  }

  // 1. GET /api/inventory - Storefront sanitized inventory (with or without trailing slash)
  if (req.method === 'GET' && (pathname === '/api/inventory' || pathname === '/api/inventory/')) {
    const inv = await getSanitizedInventory();
    return sendJson(res, 200, { success: true, inventory: inv });
  }

  // 2. GET /api/inventory/:code - Single item sanitized inventory
  if (req.method === 'GET' && pathname.startsWith('/api/inventory/')) {
    let rawCode = pathname.substring('/api/inventory/'.length);
    try {
      rawCode = decodeURIComponent(rawCode);
    } catch (_) {}
    const code = rawCode.replace(/\/+$/, '').trim().toUpperCase();
    if (!code) {
      const inv = await getSanitizedInventory();
      return sendJson(res, 200, { success: true, inventory: inv });
    }
    const item = await getSanitizedArtworkInventory(code);
    if (!item) {
      return sendJson(res, 404, { success: false, error: `Artwork code ${code} not found.` });
    }
    return sendJson(res, 200, { success: true, item });
  }

  // 3. POST /api/orders/original
  if (req.method === 'POST' && pathname === '/api/orders/original') {
    try {
      const body = await parseJsonBody(req);
      const { inventoryCode, customer, paymentVerification, clientRequestId } = body;

      const codeError = validateInventoryCode(inventoryCode);
      if (codeError) {
        const isNotFound = codeError.includes('not recognized');
        return sendJson(res, isNotFound ? 404 : 400, { success: false, error: codeError });
      }

      const customerError = validateCustomer(customer, true);
      if (customerError) {
        return sendJson(res, 400, { success: false, error: customerError });
      }

      if (clientRequestId && (typeof clientRequestId !== 'string' || clientRequestId.length > 80)) {
        return sendJson(res, 400, { success: false, error: 'clientRequestId must not exceed 80 characters.' });
      }
      const requestIdError = validateClientRequestId(clientRequestId);
      if (requestIdError) return sendJson(res, 400, { success: false, error: requestIdError });

      const result = await purchaseOriginal({
        inventoryCode: inventoryCode.trim().toUpperCase(),
        customer,
        paymentVerification,
        clientRequestId
      });

      return sendJson(res, result.statusCode, { ...result, order: publicOrder(result.order, { keepCustomerName: true }) });
    } catch (err) {
      return handleRequestError(res, err);
    }
  }

  // 4. POST /api/orders/custom
  if (req.method === 'POST' && pathname === '/api/orders/custom') {
    try {
      const body = await parseJsonBody(req);
      const {
        inventoryCode,
        requestedDimensions,
        desiredModifications,
        isQuotationRequired,
        customer,
        clientRequestId
      } = body;

      const codeError = validateInventoryCode(inventoryCode);
      if (codeError) {
        const isNotFound = codeError.includes('not recognized');
        return sendJson(res, isNotFound ? 404 : 400, { success: false, error: codeError });
      }

      const customerError = validateCustomer(customer, false);
      if (customerError) {
        return sendJson(res, 400, { success: false, error: customerError });
      }

      if (requestedDimensions && (typeof requestedDimensions !== 'string' || requestedDimensions.length > 100)) {
        return sendJson(res, 400, { success: false, error: 'requestedDimensions must not exceed 100 characters.' });
      }

      if (desiredModifications && (typeof desiredModifications !== 'string' || desiredModifications.length > 1000)) {
        return sendJson(res, 400, { success: false, error: 'desiredModifications must not exceed 1000 characters.' });
      }
      const requestIdError = validateClientRequestId(clientRequestId);
      if (requestIdError) return sendJson(res, 400, { success: false, error: requestIdError });

      const result = await commissionArtwork({
        inventoryCode: inventoryCode.trim().toUpperCase(),
        requestedDimensions,
        desiredModifications,
        isQuotationRequired,
        customer,
        clientRequestId
      });

      return sendJson(res, result.statusCode, { ...result, order: publicOrder(result.order) });
    } catch (err) {
      return handleRequestError(res, err);
    }
  }

/**
 * Create a genuine order via Razorpay's official server-side API.
 * Never constructs synthetic fake order IDs.
 */
async function createRazorpayGatewayOrder({ amountPaise, currency, receipt, notes }) {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    throw new Error('Razorpay credentials not configured');
  }

  const endpoint = process.env.RAZORPAY_API_URL || 'https://api.razorpay.com/v1/orders';
  const authHeader = 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64');

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': authHeader,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      amount: amountPaise,
      currency: currency.toUpperCase(),
      receipt: String(receipt).substring(0, 40),
      notes: notes || {}
    })
  });

  const data = await response.json();
  if (!response.ok) {
    const errMsg = data?.error?.description || data?.error?.message || `Gateway HTTP ${response.status}`;
    const err = new Error(`Razorpay gateway order creation failed: ${errMsg}`);
    err.statusCode = response.status;
    throw err;
  }

  return data;
}

  // 5. POST /api/checkout/quote - Authoritative Cart Quotation
  if (req.method === 'POST' && pathname === '/api/checkout/quote') {
    try {
      const body = await parseJsonBody(req);
      if (body.country !== undefined && (typeof body.country !== 'string' || body.country.length > 60)) {
        return sendJson(res, 400, { success: false, error: 'Country must be a string of at most 60 characters.' });
      }
      const itemError = validateCartItems(body.items, { quote: true });
      if (itemError) return sendJson(res, 400, { success: false, error: itemError });
      const quote = await quoteCart({ customer: body.customer, country: body.country, items: body.items });
      if (!quote.success) {
        return sendJson(res, quote.statusCode || 400, quote);
      }
      return sendJson(res, 200, quote);
    } catch (err) {
      return handleRequestError(res, err);
    }
  }

  // 6. POST /api/checkout/create-order - Multi-item Cart or Buy Now Order Creation
  if (req.method === 'POST' && pathname === '/api/checkout/create-order') {
    try {
      const body = await parseJsonBody(req);
      const { customer, items, clientRequestId, paymentMethod } = body;

      const customerError = validateCustomer(customer, true);
      if (customerError) {
        return sendJson(res, 400, { success: false, error: customerError });
      }
      const itemError = validateCartItems(items);
      if (itemError) return sendJson(res, 400, { success: false, error: itemError });
      if (paymentMethod !== undefined && !['studio_standard', 'razorpay'].includes(paymentMethod)) {
        return sendJson(res, 400, { success: false, error: 'Invalid payment method.' });
      }
      const requestIdError = validateClientRequestId(clientRequestId);
      if (requestIdError) return sendJson(res, 400, { success: false, error: requestIdError });

      if (!items || !Array.isArray(items) || items.length === 0) {
        return sendJson(res, 400, { success: false, error: 'At least one item is required in checkout order.' });
      }

      const hasGatewayCreds = Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
      const allowDemo = process.env.ALLOW_DEMO_CHECKOUT === 'true' && process.env.NODE_ENV !== 'production';

      // Fail closed if gateway credentials are missing and not in explicit test/demo mode
      if (!hasGatewayCreds && !allowDemo) {
        return sendJson(res, 503, {
          success: false,
          error: 'Live payment gateway credentials are not configured. Online checkout is temporarily unavailable. Please contact the studio directly for acquisition inquiries.'
        });
      }

      const result = await createCartOrder({
        customer,
        items,
        clientRequestId,
        paymentMethod
      });

      if (!result.success) {
        return sendJson(res, result.statusCode, result);
      }

      const orderCurrency = result.order.currency || ((!customer.country || customer.country.toLowerCase().trim() === 'india') ? 'INR' : 'USD');
      const isDomestic = orderCurrency === 'INR';
      const currency = orderCurrency;
      const orderSubtotal = result.order.subtotalNumeric ?? result.subtotalNumeric;
      const amountPaise = Math.round(orderSubtotal * 100);

      // If Razorpay live gateway credentials configured: create real order on gateway
      if (hasGatewayCreds) {
        if (result.order.razorpayOrderId) {
          return sendJson(res, 201, {
            success: true,
            order: publicOrder(result.order),
            razorpayOrderId: result.order.razorpayOrderId,
            keyId: process.env.RAZORPAY_KEY_ID,
            amount: amountPaise,
            currency
          });
        }
        try {
          const rzpOrder = await createRazorpayGatewayOrder({
            amountPaise,
            currency,
            receipt: result.order.orderId,
            notes: {
              orderId: result.order.orderId,
              customerName: customer.name,
              customerEmail: customer.email
            }
          });

          // Associate official gateway order ID with our order record
          result.order = await updateRazorpayOrderId(result.order.orderId, rzpOrder.id) || result.order;
          const canonicalRazorpayOrderId = result.order.razorpayOrderId || rzpOrder.id;

          return sendJson(res, 201, {
            success: true,
            order: publicOrder(result.order),
            razorpayOrderId: canonicalRazorpayOrderId,
            keyId: process.env.RAZORPAY_KEY_ID,
            amount: rzpOrder.id === canonicalRazorpayOrderId ? (rzpOrder.amount || amountPaise) : amountPaise,
            currency: rzpOrder.id === canonicalRazorpayOrderId ? (rzpOrder.currency || currency) : currency
          });
        } catch (gatewayErr) {
          console.error(`[GATEWAY] Razorpay order creation failed (HTTP ${gatewayErr.statusCode || 'unknown'}).`);
          const latestOrder = (await getOrders()).find(order => order.orderId === result.order.orderId);
          if (latestOrder?.razorpayOrderId) {
            return sendJson(res, 201, {
              success: true,
              order: publicOrder(latestOrder),
              razorpayOrderId: latestOrder.razorpayOrderId,
              keyId: process.env.RAZORPAY_KEY_ID,
              amount: amountPaise,
              currency
            });
          }
          // Release reserved items immediately so inventory is not blocked
          await cancelCheckoutReservation(result.order.orderId);
          return sendJson(res, 502, {
            success: false,
            error: 'Payment gateway initialization failed. Artwork reservation released; please retry or contact the studio.'
          });
        }
      }

      // Demo/staging fallback (only when ALLOW_DEMO_CHECKOUT is true and NODE_ENV !== 'production')
      return sendJson(res, 201, {
        success: true,
        demoMode: true,
        order: publicOrder(result.order),
        razorpayOrderId: null,
        amount: amountPaise,
        currency,
        message: 'Demo checkout mode active. Payment simulation only, real payments disabled.'
      });
    } catch (err) {
      return handleRequestError(res, err);
    }
  }

  // 7. POST /api/checkout/verify-payment - Cryptographic Payment Signature Verification
  if (req.method === 'POST' && pathname === '/api/checkout/verify-payment') {
    try {
      const body = await parseJsonBody(req);
      const { orderId, razorpayOrderId, razorpayPaymentId, razorpaySignature } = body;

      if (typeof orderId !== 'string' || !orderId || orderId.length > 100) {
        return sendJson(res, 400, { success: false, error: 'A valid orderId is required.' });
      }

      const orders = await getOrders();
      const order = orders.find(o => o.orderId === orderId);
      if (!order) {
        return sendJson(res, 404, { success: false, error: `Order ${orderId} not found.` });
      }

      const secret = process.env.RAZORPAY_KEY_SECRET;
      const allowDemo = process.env.ALLOW_DEMO_CHECKOUT === 'true' && process.env.NODE_ENV !== 'production';

      // If credentials missing: fail closed unless explicit non-production demo mode
      if (!secret) {
        if (!allowDemo) {
          return sendJson(res, 503, {
            success: false,
            error: 'Payment verification secret is not configured. Live payment verification failed closed.'
          });
        }

        const updateRes = await updateOrderPaymentStatus(orderId, {
          paymentStatus: 'demo_simulated',
          razorpayPaymentId: razorpayPaymentId || `demo_pay_${Date.now()}`
        });
        return sendJson(res, 200, {
          success: true,
          demoMode: true,
          order: publicOrder(updateRes.order),
          message: 'Demo checkout payment simulation recorded (staging/test only). Artwork not marked sold.'
        });
      }

      // Live verification: require authentic fields
      if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
        return sendJson(res, 400, { success: false, error: 'Missing required Razorpay payment verification fields.' });
      }
      if (![razorpayOrderId, razorpayPaymentId].every(value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value)) ||
          typeof razorpaySignature !== 'string' || !/^[a-f0-9]{64}$/i.test(razorpaySignature)) {
        return sendJson(res, 400, { success: false, error: 'Invalid Razorpay payment verification fields.' });
      }

      // If order has an assigned razorpayOrderId, ensure it matches
      if (order.razorpayOrderId && order.razorpayOrderId !== razorpayOrderId) {
        return sendJson(res, 400, { success: false, error: 'Mismatched Razorpay order ID.' });
      }

      const expectedSignature = crypto
        .createHmac('sha256', secret)
        .update(`${razorpayOrderId}|${razorpayPaymentId}`)
        .digest('hex');

      const sigBuf = Buffer.from(razorpaySignature, 'utf-8');
      const expBuf = Buffer.from(expectedSignature, 'utf-8');

      if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
        return sendJson(res, 400, { success: false, error: 'Invalid payment signature. Verification failed.' });
      }

      const updateRes = await updateOrderPaymentStatus(orderId, {
        paymentStatus: 'confirmed',
        razorpayPaymentId
      });

      if (!updateRes.success) {
        return sendJson(res, updateRes.statusCode || 400, { success: false, error: updateRes.error });
      }

      return sendJson(res, 200, {
        success: true,
        order: publicOrder(updateRes.order),
        message: 'Payment verified successfully. Artwork acquisition confirmed.'
      });
    } catch (err) {
      return handleRequestError(res, err);
    }
  }

  // 8. POST /api/payment/webhook - Idempotent Payment Webhook
  if (req.method === 'POST' && pathname === '/api/payment/webhook') {
    try {
      const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
      if (!webhookSecret) {
        return sendJson(res, 503, {
          success: false,
          error: 'Payment webhook secret is not configured. Webhook rejected.'
        });
      }

      const signature = req.headers['x-razorpay-signature'];
      if (typeof signature !== 'string' || !/^[a-f0-9]{64}$/i.test(signature)) {
        return sendJson(res, 400, { success: false, error: 'Missing webhook signature.' });
      }

      const rawBody = await parseRawBody(req);
      const expectedSignature = crypto
        .createHmac('sha256', webhookSecret)
        .update(rawBody)
        .digest('hex');

      const sigBuf = Buffer.from(signature, 'utf-8');
      const expBuf = Buffer.from(expectedSignature, 'utf-8');

      if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
        return sendJson(res, 400, { success: false, error: 'Invalid webhook signature.' });
      }

      let body;
      try {
        body = JSON.parse(rawBody || '{}');
      } catch {
        return sendJson(res, 400, { success: false, error: 'Invalid JSON payload in webhook.' });
      }

      const eventId = req.headers['x-razorpay-event-id'] || null;
      if (eventId !== null && (typeof eventId !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(eventId))) {
        return sendJson(res, 400, { success: false, error: 'Invalid webhook event identifier.' });
      }

      if (body.event === 'payment.captured' && body.payload?.payment?.entity) {
        const p = body.payload.payment.entity;
        if (typeof p.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(p.id)) {
          return sendJson(res, 400, { success: false, error: 'Invalid payment identifier in webhook.' });
        }
        const orders = await getOrders();
        const order = orders.find(o => o.orderId === p.notes?.orderId || (o.razorpayOrderId && o.razorpayOrderId === p.order_id));
        if (order) {
          if ((order.razorpayOrderId && order.razorpayOrderId !== p.order_id) ||
              (process.env.NODE_ENV === 'production' && !order.razorpayOrderId)) {
            return sendJson(res, 400, { success: false, error: 'Payment gateway order does not match the studio order.' });
          }
          // Amount & Currency verification
          const orderCurrency = (order.currency || 'INR').toUpperCase();
          if (typeof p.currency !== 'string' || p.currency.toUpperCase() !== orderCurrency) {
            return sendJson(res, 400, {
              success: false,
              error: `Currency mismatch: payment currency "${String(p.currency || 'missing')}" does not match order currency "${orderCurrency}".`
            });
          }

          const numTotal = parseFloat(String(order.total || order.subtotal || '0').replace(/[^0-9.]/g, '')) || 0;
          const expectedAmountPaise = Math.round(numTotal * 100);
          if (!Number.isSafeInteger(p.amount) || p.amount !== expectedAmountPaise) {
            return sendJson(res, 400, {
              success: false,
              error: `Amount mismatch: payment amount ${p.amount} does not match order amount ${expectedAmountPaise}.`
            });
          }

          const updateRes = await updateOrderPaymentStatus(order.orderId, {
            paymentStatus: 'confirmed',
            razorpayPaymentId: p.id,
            eventId,
            eventType: body.event
          });

          if (!updateRes.success) {
            // A real capture can arrive after the checkout hold expires. Acknowledge
            // the authenticated event to stop retries, but leave the order for review.
            console.warn(`[PAYMENT] Captured payment requires reconciliation for order ${order.orderId}.`);
            return sendJson(res, 200, {
              success: false,
              received: true,
              requiresReview: true,
              error: 'Payment was received but needs studio review.'
            });
          }

          return sendJson(res, 200, { success: true, order: publicOrder(updateRes.order), message: 'Payment captured and verified.' });
        }
      }

      if (body.event === 'payment.failed' && body.payload?.payment?.entity) {
        const p = body.payload.payment.entity;
        if (typeof p.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(p.id)) {
          return sendJson(res, 400, { success: false, error: 'Invalid payment identifier in webhook.' });
        }
        const orders = await getOrders();
        const order = orders.find(o => o.orderId === p.notes?.orderId || (o.razorpayOrderId && o.razorpayOrderId === p.order_id));
        if (order) {
          await updateOrderPaymentStatus(order.orderId, {
            paymentStatus: 'failed',
            razorpayPaymentId: p.id,
            eventId,
            eventType: body.event
          });
        }
        return sendJson(res, 200, { success: true, message: 'Payment failure recorded and hold released.' });
      }

      return sendJson(res, 200, { success: true, received: true });
    } catch (err) {
      return handleRequestError(res, err);
    }
  }

  // 9. POST /api/checkout/cancel-order - Cancel Pending Checkout & Release Artwork Reservation Hold
  if (req.method === 'POST' && pathname === '/api/checkout/cancel-order') {
    try {
      const body = await parseJsonBody(req);
      const { orderId } = body;
      if (!orderId) {
        return sendJson(res, 400, { success: false, error: 'orderId is required.' });
      }
      const result = await cancelCheckoutReservation(orderId);
      return sendJson(res, result.success ? 200 : result.statusCode || 400, { ...result, order: publicOrder(result.order) });
    } catch (err) {
      return handleRequestError(res, err);
    }
  }

  // 9. GET /api/orders (Administrative only: protected against public customer data leakage)
  if (req.method === 'GET' && pathname === '/api/orders') {
    const authHeader = req.headers['authorization'] || '';
    const adminKey = process.env.ADMIN_API_KEY;

    // Strict access control: If ADMIN_API_KEY is unset or token doesn't match, deny access
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!adminKey || !safeAdminKeyMatch(token, adminKey)) {
      return sendJson(res, 403, {
        success: false,
        error: 'Unauthorized access to order records. Administrative authentication is required.'
      });
    }

    const orders = await getOrders();
    return sendJson(res, 200, { success: true, count: orders.length, orders });
  }

  // 6. POST /api/test/reset (Internal test runner helper - gated to test environments only)
  if (req.method === 'POST' && pathname === '/api/test/reset') {
    if (process.env.NODE_ENV !== 'test') {
      return sendJson(res, 403, {
        success: false,
        error: 'Test reset endpoint is disabled outside automated test environments.'
      });
    }
    await resetTestStore();
    return sendJson(res, 200, { success: true, message: 'Test database reset successfully.' });
  }

  // Fallback for unmatched API endpoints: return JSON 404, never serve static files
  if (pathname.startsWith('/api/')) {
    return sendJson(res, 404, { success: false, error: 'API endpoint not found.' });
  }

  // Static storefront content is served by Netlify. The Render API must never
  // expose source files, JSON stores, environment examples, or repository files.
  if (process.env.NODE_ENV === 'production') {
    return sendJson(res, 404, { success: false, error: 'Not found.' });
  }

  // Fallback: Static Files for local development only
  serveStatic(req, res, pathname);
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch(error => handleRequestError(res, error));
});

export function startServer(port = PORT) {
  return new Promise((resolve, reject) => {
    server.listen(port, () => {
      resolve(server);
    });
    server.on('error', reject);
  });
}

// Auto-run if executed directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startServer(PORT).then(() => {
    console.log(`[SHWETA STUDIO SERVER] Running at http://localhost:${PORT}`);
  });
}

export default server;
