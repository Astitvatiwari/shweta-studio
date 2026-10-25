// server.js - Node.js HTTP server and persistent inventory API for Shweta Studio
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import artworks from './artworks.js';
import {
  getSanitizedInventory,
  getSanitizedArtworkInventory,
  purchaseOriginal,
  commissionArtwork,
  getOrders,
  resetTestStore
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
  const limit = 60;

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
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 50000) { // 50KB strict limit
        req.destroy();
        reject(new Error('Request payload exceeds permitted maximum size (50KB).'));
      }
    });
    req.on('end', () => {
      if (!body.trim()) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(new Error('Malformed JSON payload.'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, data) {
  const jsonStr = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With'
  });
  res.end(jsonStr);
}

/**
 * Validates customer contact and delivery details.
 */
function validateCustomer(customer, isOriginalOrder = false) {
  if (!customer || typeof customer !== 'object') {
    return 'Customer information object is required.';
  }

  const { name, email, phone, country, address } = customer;

  if (!name || typeof name !== 'string' || name.trim().length === 0 || name.length > 100) {
    return 'Customer name is required and must not exceed 100 characters.';
  }

  if (!email || typeof email !== 'string' || email.length > 120) {
    return 'Customer email is required and must not exceed 120 characters.';
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email.trim())) {
    return 'Invalid email address format.';
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

function serveStatic(req, res, pathname) {
  // Reject null-byte injection attempts
  if (pathname.includes('\0')) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    return res.end('400 Bad Request');
  }

  let safePath = path.normalize(decodeURIComponent(pathname)).replace(/^(\.\.[\/\\])+/, '');
  if (safePath === '/' || safePath === '\\') safePath = '/index.html';

  const filePath = path.join(__dirname, safePath);

  // Security check: must stay within project root
  if (!filePath.startsWith(__dirname)) {
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
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN',
      'Referrer-Policy': 'strict-origin-when-cross-origin'
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  // Handle CORS Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
      'X-Content-Type-Options': 'nosniff'
    });
    return res.end();
  }

  const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = reqUrl.pathname;
  const clientIp = req.socket.remoteAddress || '127.0.0.1';

  // Rate limit API endpoints
  if (pathname.startsWith('/api/')) {
    if (!checkRateLimit(clientIp)) {
      return sendJson(res, 429, { success: false, error: 'Rate limit exceeded. Please try again shortly.' });
    }
  }

  // 1. GET /api/inventory - Storefront sanitized inventory
  if (req.method === 'GET' && pathname === '/api/inventory') {
    const inv = getSanitizedInventory();
    return sendJson(res, 200, { success: true, inventory: inv });
  }

  // 2. GET /api/inventory/:code - Single item sanitized inventory
  if (req.method === 'GET' && pathname.startsWith('/api/inventory/')) {
    const code = pathname.substring('/api/inventory/'.length).trim().toUpperCase();
    const item = getSanitizedArtworkInventory(code);
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

      const result = await purchaseOriginal({
        inventoryCode: inventoryCode.trim().toUpperCase(),
        customer,
        paymentVerification,
        clientRequestId
      });

      return sendJson(res, result.statusCode, result);
    } catch (err) {
      return sendJson(res, 400, { success: false, error: err.message });
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

      const result = await commissionArtwork({
        inventoryCode: inventoryCode.trim().toUpperCase(),
        requestedDimensions,
        desiredModifications,
        isQuotationRequired,
        customer,
        clientRequestId
      });

      return sendJson(res, result.statusCode, result);
    } catch (err) {
      return sendJson(res, 400, { success: false, error: err.message });
    }
  }

  // 5. GET /api/orders (Administrative only: protected against public customer data leakage)
  if (req.method === 'GET' && pathname === '/api/orders') {
    const authHeader = req.headers['authorization'] || '';
    const adminKey = process.env.ADMIN_API_KEY;

    // Strict access control: If ADMIN_API_KEY is unset or token doesn't match, deny access
    if (!adminKey || authHeader !== `Bearer ${adminKey}`) {
      return sendJson(res, 403, {
        success: false,
        error: 'Unauthorized access to order records. Administrative authentication is required.'
      });
    }

    const orders = getOrders();
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
    resetTestStore();
    return sendJson(res, 200, { success: true, message: 'Test database reset successfully.' });
  }

  // Fallback: Static Files
  serveStatic(req, res, pathname);
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
