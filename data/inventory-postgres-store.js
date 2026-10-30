import crypto from 'node:crypto';
import pg from 'pg';
import artworks from '../artworks.js';
import { postgresConnectionOptions } from './postgres-connection.js';
import {
  calculatePreparationTime,
  getAuthoritativePrice,
  sanitizeStorefrontItem
} from './inventory-file-store.js';

const { Pool } = pg;
if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required when STORAGE_BACKEND=postgres.');
}
export const CHECKOUT_RESERVATION_TTL_MS = parseInt(process.env.CHECKOUT_RESERVATION_TTL_MS || '900000', 10);
const pool = new Pool({
  ...postgresConnectionOptions(process.env.DATABASE_URL),
  max: Number.parseInt(process.env.PGPOOL_MAX || '10', 10),
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000
});

const transitions = {
  payment_pending: ['confirmed', 'failed', 'cancelled', 'expired', 'demo_simulated'],
  pending: ['confirmed', 'failed', 'cancelled', 'expired', 'demo_simulated'],
  demo_simulated: ['confirmed', 'cancelled', 'failed'],
  failed: ['payment_pending', 'cancelled', 'expired'],
  confirmed: [], cancelled: [], expired: []
};

function asInventory(row) {
  if (!row) return null;
  const item = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
  return {
    ...item,
    inventoryCode: row.inventory_code,
    status: row.status,
    originalQuantity: row.original_quantity,
    reservationType: row.reservation_type,
    reservedUntil: row.reserved_until ? new Date(row.reserved_until).toISOString() : null,
    reservedOrderId: row.reserved_order_id,
    lastUpdated: new Date(row.updated_at).toISOString()
  };
}

function asOrder(row) {
  if (!row) return null;
  const order = typeof row.order_data === 'string' ? JSON.parse(row.order_data) : row.order_data;
  return {
    ...order,
    orderId: row.order_id,
    clientRequestId: row.client_request_id,
    orderType: row.order_type,
    paymentStatus: row.payment_status,
    razorpayOrderId: row.razorpay_order_id,
    razorpayPaymentId: row.razorpay_payment_id
  };
}

function makeOrderId(prefix = 'ORD') {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

function catalogRecord(art) {
  const code = art.inventoryCode.trim().toUpperCase();
  const status = art.availability || 'Available';
  const reserved = status === 'Reserved';
  const item = {
    id: art.id,
    inventoryCode: code,
    slug: art.slug,
    title: art.title,
    category: art.category,
    medium: art.medium,
    price: art.price,
    initialAvailability: art.availability,
    originalQuantity: reserved ? 0 : 1,
    status,
    reservationType: reserved ? 'manual_studio' : null,
    reservedUntil: null,
    reservedOrderId: null,
    preparationTime: calculatePreparationTime(art),
    image: art.cardImage || art.images?.[0] || null,
    cardImage: art.cardImage || art.images?.[0] || null,
    soldAt: null,
    orderId: null,
    lastUpdated: new Date().toISOString()
  };
  return { code, item };
}

function formatPrice(amount, domestic) {
  return domestic ? `₹${amount.toLocaleString('en-IN')}` : `$${amount.toLocaleString('en-US')}`;
}

function safeJson(value) {
  return JSON.stringify(value ?? {});
}

async function defaultTransaction(work) {
  const client = await pool.connect();
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
}

// Injection point supports isolated PostgreSQL-compatible tests without creating a
// hosted database. Production always uses a real node-postgres Pool transaction.
export function createPostgresStore({ query = pool.query.bind(pool), transaction = defaultTransaction, catalog = artworks } = {}) {
  async function seedCatalog(client) {
    const records = catalog.map(catalogRecord);
    await client.query(
      `INSERT INTO inventory
        (inventory_code, status, original_quantity, reservation_type, reserved_until, reserved_order_id, data, updated_at)
       SELECT seed.code, seed.status, seed.quantity, seed.reservation_type, NULL, NULL, seed.data::jsonb, now()
       FROM unnest($1::text[], $2::text[], $3::integer[], $4::text[], $5::text[])
         AS seed(code, status, quantity, reservation_type, data)
       ON CONFLICT (inventory_code) DO NOTHING`,
      [records.map(({ code }) => code), records.map(({ item }) => item.status),
        records.map(({ item }) => item.originalQuantity), records.map(({ item }) => item.reservationType),
        records.map(({ item }) => safeJson(item))]
    );
  }

  async function expireHolds(client) {
    const candidates = await client.query(
      `SELECT DISTINCT reserved_order_id FROM inventory
       WHERE reservation_type='checkout_hold' AND reserved_until <= now()
       AND reserved_order_id IS NOT NULL ORDER BY reserved_order_id`
    );
    for (const { reserved_order_id: orderId } of candidates.rows) {
      // All payment transitions lock the order first, then inventory. Keep this
      // same lock order here to avoid deadlocks during expiry/payment races.
      const orderResult = await client.query('SELECT * FROM orders WHERE order_id=$1 FOR UPDATE', [orderId]);
      const order = asOrder(orderResult.rows[0]);
      const expired = await client.query(
        `SELECT * FROM inventory WHERE reserved_order_id=$1 AND reservation_type='checkout_hold'
         AND reserved_until <= now() ORDER BY inventory_code FOR UPDATE`, [orderId]
      );
      if (!expired.rowCount) continue;
      const timestamp = new Date().toISOString();
      for (const row of expired.rows) {
        const item = { ...asInventory(row), status: 'Available', originalQuantity: 1, reservationType: null,
          reservedUntil: null, reservedOrderId: null, lastUpdated: timestamp };
        await client.query(
          `UPDATE inventory SET status='Available', original_quantity=1, reservation_type=NULL,
            reserved_until=NULL, reserved_order_id=NULL, data=$2::jsonb, updated_at=now()
           WHERE inventory_code=$1`, [row.inventory_code, safeJson(item)]
        );
      }
      if (order && ['payment_pending', 'pending', 'failed'].includes(order.paymentStatus)) {
        order.paymentStatus = 'expired';
        order.updatedAt = timestamp;
        await client.query(
          `UPDATE orders SET payment_status='expired', order_data=$2::jsonb, updated_at=now()
           WHERE order_id=$1`, [orderId, safeJson(order)]
        );
      }
    }
  }

  async function inventoryMap(client = null) {
    const result = client
      ? await client.query('SELECT * FROM inventory ORDER BY inventory_code')
      : await query('SELECT * FROM inventory ORDER BY inventory_code');
    return Object.fromEntries(result.rows.map(row => [row.inventory_code, asInventory(row)]));
  }

  async function readOrders(client = null) {
    const result = client
      ? await client.query('SELECT * FROM orders ORDER BY created_at, order_id')
      : await query('SELECT * FROM orders ORDER BY created_at, order_id');
    return result.rows.map(asOrder);
  }

  async function writeOrder(client, order) {
    await client.query(
      `INSERT INTO orders (order_id, client_request_id, order_type, payment_status,
        razorpay_order_id, razorpay_payment_id, order_data, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,COALESCE($8::timestamptz,now()),now())`,
      [order.orderId, order.clientRequestId || null, order.orderType || 'cart_multi',
        order.paymentStatus || 'payment_pending', order.razorpayOrderId || null,
        order.razorpayPaymentId || null, safeJson(order), order.createdAt || null]
    );
    const items = Array.isArray(order.items) ? order.items : (order.inventoryCode ? [{
      inventoryCode: order.inventoryCode, purchaseType: order.orderType === 'commission' ? 'commission' : 'original', quantity: 1
    }] : []);
    for (const [index, item] of items.entries()) {
      await client.query(
        `INSERT INTO order_items (order_id,item_index,inventory_code,purchase_type,quantity,item_data)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
        [order.orderId, index, item.inventoryCode, item.purchaseType || 'original', item.quantity || 1, safeJson(item)]
      );
    }
  }

  async function getInventory() {
    return transaction(async client => {
      await seedCatalog(client);
      await expireHolds(client);
      return inventoryMap(client);
    });
  }

  async function getSanitizedInventory() {
    const inventory = await getInventory();
    return Object.fromEntries(Object.entries(inventory).map(([code, item]) => [code, sanitizeStorefrontItem(item)]));
  }

  async function getArtworkInventory(code) {
    const inventory = await getInventory();
    return inventory[String(code || '').trim().toUpperCase()] || null;
  }

  async function getSanitizedArtworkInventory(code) {
    return sanitizeStorefrontItem(await getArtworkInventory(code));
  }

  async function getOrders() {
    return readOrders();
  }

  async function initializeInventory() {
    return transaction(async client => {
      await seedCatalog(client);
      await expireHolds(client);
      return inventoryMap(client);
    });
  }

  async function cleanExpiredReservations() {
    await transaction(expireHolds);
    return getInventory();
  }

  async function quoteCart({ customer, country, items }) {
    if (!Array.isArray(items) || items.length === 0) return { success: false, statusCode: 400, error: 'No items provided for quotation.' };
    const inventory = await getInventory();
    const destination = country || customer?.country || 'India';
    const domestic = destination.toLowerCase().trim() === 'india';
    let totalNumeric = 0;
    const itemQuotes = [];
    for (const line of items) {
      const code = String(line.inventoryCode || '').trim().toUpperCase();
      const item = inventory[code];
      if (!item) return { success: false, statusCode: 400, error: `Unknown artwork code "${code || 'empty'}" in cart.` };
      const rawQty = line.quantity == null || String(line.quantity).trim() === '' ? 1 : Number.parseInt(line.quantity, 10);
      if (!Number.isInteger(rawQty) || rawQty < 1 || rawQty > 20) return { success: false, statusCode: 400, error: `Invalid quantity for item "${item.title}".` };
      if (line.purchaseType === 'original' && (!item.price || item.status === 'Available on Inquiry')) {
        return { success: false, statusCode: 400, error: `Artwork "${item.title}" is available on inquiry only.` };
      }
      const unitPrice = getAuthoritativePrice(item, destination);
      const numeric = Number.parseFloat(String(unitPrice || '0').replace(/[^0-9.]/g, '')) || 0;
      const quantity = line.purchaseType === 'original' ? 1 : rawQty;
      totalNumeric += numeric * quantity;
      itemQuotes.push({ inventoryCode: code, title: item.title, purchaseType: line.purchaseType || 'original', unitPrice,
        quantity, isAvailable: line.purchaseType === 'original' ? item.status === 'Available' && item.originalQuantity > 0 : true,
        status: item.status });
    }
    return { success: true, currency: domestic ? 'INR' : 'USD', subtotal: totalNumeric,
      subtotalFormatted: formatPrice(totalNumeric, domestic), total: formatPrice(totalNumeric, domestic),
      totalNumeric, items: itemQuotes };
  }

  async function createCartOrder({ customer, items, clientRequestId, paymentMethod }) {
    if (!Array.isArray(items) || items.length === 0) return { success: false, statusCode: 400, error: 'No items provided in order request.' };
    try {
      return await transaction(async client => {
        await seedCatalog(client);
        await expireHolds(client);
        if (clientRequestId) {
          const existing = await client.query('SELECT * FROM orders WHERE client_request_id=$1', [clientRequestId]);
          if (existing.rowCount) return { success: true, statusCode: 200, order: asOrder(existing.rows[0]), message: 'Order already processed successfully (idempotent request).' };
        }

        const originals = [...new Set(items.filter(x => x.purchaseType === 'original')
          .map(x => String(x.inventoryCode || '').trim().toUpperCase()))].sort();
        if (originals.length) {
          await client.query('SELECT inventory_code FROM inventory WHERE inventory_code = ANY($1::text[]) ORDER BY inventory_code FOR UPDATE', [originals]);
        }
        // A retry may have waited on a different artwork lock while the first request committed.
        if (clientRequestId) {
          const existing = await client.query('SELECT * FROM orders WHERE client_request_id=$1', [clientRequestId]);
          if (existing.rowCount) return { success: true, statusCode: 200, order: asOrder(existing.rows[0]), message: 'Order already processed successfully (idempotent request).' };
        }
        const inventory = await inventoryMap(client);
        const domestic = !customer?.country || customer.country.toLowerCase().trim() === 'india';
        const currency = domestic ? 'INR' : 'USD';
        let subtotalNumeric = 0;
        const verifiedItems = [];
        for (const line of items) {
          const code = String(line.inventoryCode || '').trim().toUpperCase();
          const item = inventory[code];
          if (!item) return { success: false, statusCode: 404, error: `Artwork code ${code} not found in studio catalog.` };
          if (line.purchaseType === 'original') {
            if (item.status === 'Sold' || item.originalQuantity <= 0) return { success: false, statusCode: 409,
              error: `Unique 1-of-1 original "${item.title}" (${item.inventoryCode}) has already been sold. Please remove it from your bag to proceed.`, unavailableCode: item.inventoryCode };
            if (item.status === 'Reserved') return { success: false, statusCode: 409,
              error: item.reservationType === 'checkout_hold'
                ? `Original artwork "${item.title}" is temporarily reserved in another collector's checkout. Please try again shortly.`
                : `Original artwork "${item.title}" is currently reserved.`, unavailableCode: item.inventoryCode };
            if (!item.price || item.status === 'Available on Inquiry') return { success: false, statusCode: 400,
              error: `Artwork "${item.title}" is available on inquiry only. Direct online purchase is not permitted.`, unavailableCode: item.inventoryCode };
          }
          const price = getAuthoritativePrice(item, customer?.country);
          const numeric = Number.parseFloat(String(price || '0').replace(/[^0-9.]/g, '')) || 0;
          const rawQty = line.quantity == null || String(line.quantity).trim() === '' ? 1 : Number.parseInt(line.quantity, 10);
          if (line.purchaseType !== 'original' && (!Number.isInteger(rawQty) || rawQty < 1 || rawQty > 20)) return { success: false, statusCode: 400, error: `Invalid quantity for item "${item.title}".` };
          const quantity = line.purchaseType === 'original' ? 1 : rawQty;
          subtotalNumeric += numeric * quantity;
          verifiedItems.push({ inventoryCode: item.inventoryCode, title: item.title, category: item.category, medium: item.medium,
            purchaseType: line.purchaseType || 'original', quantity, unitPrice: price,
            lineTotal: formatPrice(numeric * quantity, domestic), customDimensions: line.customDimensions || '',
            customModifications: line.customModifications || '', preparationTime: item.preparationTime?.displayText || '' });
        }

        const orderId = makeOrderId();
        const now = new Date();
        const expires = new Date(now.getTime() + CHECKOUT_RESERVATION_TTL_MS);
        for (const code of originals) {
          const item = inventory[code];
          const reserved = { ...item, originalQuantity: 0, status: 'Reserved', reservationType: 'checkout_hold',
            reservedUntil: expires.toISOString(), reservedOrderId: orderId, lastUpdated: now.toISOString() };
          await client.query(`UPDATE inventory SET status='Reserved', original_quantity=0, reservation_type='checkout_hold',
            reserved_until=$2, reserved_order_id=$3, data=$4::jsonb, updated_at=now() WHERE inventory_code=$1`,
          [code, expires.toISOString(), orderId, safeJson(reserved)]);
        }
        const order = { orderId, clientRequestId: clientRequestId || null,
          orderType: verifiedItems.length === 1 ? verifiedItems[0].purchaseType : 'cart_multi', items: verifiedItems,
          currency, subtotal: formatPrice(subtotalNumeric, domestic), total: formatPrice(subtotalNumeric, domestic), subtotalNumeric,
          customer: { name: customer?.name || 'Collector', email: customer?.email || '', phone: customer?.phone || '',
            country: customer?.country || 'India', address: customer?.address || '', city: customer?.city || '',
            state: customer?.state || '', postalCode: customer?.postalCode || '' },
          paymentStatus: 'payment_pending', reservationExpiresAt: expires.toISOString(), paymentMethod: paymentMethod || 'studio_standard',
          shippingNotice: domestic ? 'Complimentary insured studio delivery across India included.' : 'Insured international transit & export packaging included.',
          createdAt: now.toISOString() };
        await writeOrder(client, order);
        return { success: true, statusCode: 201, order, subtotalNumeric, message: `Order ${orderId} created successfully.` };
      });
    } catch (error) {
      if (error.code === '23505' && clientRequestId) {
        const existing = await query('SELECT * FROM orders WHERE client_request_id=$1', [clientRequestId]);
        if (existing.rowCount) return { success: true, statusCode: 200, order: asOrder(existing.rows[0]), message: 'Order already processed successfully (idempotent request).' };
      }
      throw error;
    }
  }

  async function commissionArtwork({ inventoryCode, requestedDimensions, desiredModifications, isQuotationRequired, customer, clientRequestId }) {
    try {
      return await transaction(async client => {
      await seedCatalog(client);
      const code = String(inventoryCode || '').trim().toUpperCase();
      const { rows } = await client.query('SELECT * FROM inventory WHERE inventory_code=$1', [code]);
      const item = asInventory(rows[0]);
      if (!item) return { success: false, statusCode: 404, error: `Artwork with inventory code ${code} not found.` };
      if (clientRequestId) {
        const existing = await client.query('SELECT * FROM orders WHERE client_request_id=$1 AND order_type=$2', [clientRequestId, 'commission']);
        if (existing.rowCount) return { success: true, statusCode: 200, order: asOrder(existing.rows[0]), item: sanitizeStorefrontItem(item), message: 'Commission request already recorded (idempotent request).' };
      }
      const isQuote = Boolean(isQuotationRequired);
      const prep = item.preparationTime || calculatePreparationTime(item);
      const order = { orderId: makeOrderId('COM'), clientRequestId: clientRequestId || null, orderType: 'commission',
        inventoryCode: item.inventoryCode, artworkTitle: item.title, category: item.category, medium: item.medium,
        price: isQuote ? 'Separate Studio Quotation Required' : (getAuthoritativePrice(item, customer?.country) || 'Price on Inquiry'),
        quotationStatus: isQuote ? 'quote_required' : 'standard_approved', isQuotationRequired: isQuote,
        requestedDimensions: requestedDimensions || 'Standard Original Dimensions',
        desiredModifications: desiredModifications || 'Standard made-to-order recreation', preparationTime: prep.displayText,
        preparationNotice: prep.fullNotice,
        customer: { name: customer?.name || 'Collector', email: customer?.email || '', phone: customer?.phone || '', country: customer?.country || '', address: customer?.address || '' },
        status: isQuote ? 'quotation_pending' : 'commission_confirmed', createdAt: new Date().toISOString() };
      await writeOrder(client, order);
      return { success: true, statusCode: 201, order, item: sanitizeStorefrontItem(item),
        message: isQuote ? 'Customization request submitted for studio quotation.' : `Made-to-order commission confirmed for "${item.title}". Preparation timeline: ${prep.displayText}.` };
      });
    } catch (error) {
      if (error.code === '23505' && clientRequestId) {
        const existing = await query('SELECT * FROM orders WHERE client_request_id=$1 AND order_type=$2', [clientRequestId, 'commission']);
        if (existing.rowCount) return { success: true, statusCode: 200, order: asOrder(existing.rows[0]), message: 'Commission request already recorded (idempotent request).' };
      }
      throw error;
    }
  }

  async function updateOrderPaymentStatus(orderId, { paymentStatus = 'confirmed', razorpayPaymentId = null, transactionId = null, eventId = null, eventType = null } = {}) {
    return transaction(async client => {
      const { rows } = await client.query('SELECT * FROM orders WHERE order_id=$1 FOR UPDATE', [orderId]);
      const order = asOrder(rows[0]);
      if (!order) return { success: false, statusCode: 404, error: `Order ${orderId} not found.` };
      const current = order.paymentStatus || 'payment_pending';
      if (current === paymentStatus) {
        if (razorpayPaymentId && order.razorpayPaymentId && order.razorpayPaymentId !== razorpayPaymentId) {
          return { success: false, statusCode: 409, error: 'A different payment is already associated with this order.' };
        }
        if (eventId) {
          const event = await client.query(`INSERT INTO payment_events (event_id,event_type,order_id,razorpay_payment_id)
            VALUES ($1,$2,$3,$4) ON CONFLICT (event_id) DO NOTHING RETURNING event_id`, [eventId, eventType || 'unknown', orderId, razorpayPaymentId]);
          if (!event.rowCount) {
            const prior = await client.query('SELECT order_id FROM payment_events WHERE event_id=$1', [eventId]);
            if (prior.rows[0]?.order_id !== orderId) return { success: false, statusCode: 409, error: 'Payment event ID is already associated with another order.' };
            return { success: true, duplicate: true, order, message: 'Payment event already processed.' };
          }
        }
        return { success: true, order };
      }
      if (!(transitions[current] || []).includes(paymentStatus)) return { success: false, statusCode: 400,
        error: `Invalid payment status transition from "${current}" to "${paymentStatus}".` };
      const linkedItems = await client.query(`SELECT i.* FROM inventory i
        LEFT JOIN order_items oi ON oi.inventory_code=i.inventory_code AND oi.order_id=$1 AND oi.purchase_type='original'
        WHERE oi.order_id=$1 OR (i.reservation_type='checkout_hold' AND i.reserved_order_id=$1)
        ORDER BY i.inventory_code FOR UPDATE OF i`, [orderId]);
      const timestamp = new Date().toISOString();
      if (paymentStatus === 'confirmed') {
        for (const row of linkedItems.rows) {
          const currentItem = asInventory(row);
          if (row.status === 'Sold' && currentItem.orderId === orderId) continue;
          if (row.reservation_type !== 'checkout_hold' || row.reserved_order_id !== orderId) {
            return { success: false, statusCode: 409, error: 'Artwork reservation expired or is no longer held by this order.' };
          }
        }
      }
      if (eventId) {
        const event = await client.query(`INSERT INTO payment_events (event_id,event_type,order_id,razorpay_payment_id)
          VALUES ($1,$2,$3,$4) ON CONFLICT (event_id) DO NOTHING RETURNING event_id`, [eventId, eventType || 'unknown', orderId, razorpayPaymentId]);
        if (!event.rowCount) {
          const prior = await client.query('SELECT order_id FROM payment_events WHERE event_id=$1', [eventId]);
          if (prior.rows[0]?.order_id !== orderId) return { success: false, statusCode: 409, error: 'Payment event ID is already associated with another order.' };
          return { success: true, duplicate: true, order, message: 'Payment event already processed.' };
        }
      }
      if (paymentStatus === 'confirmed') {
        for (const row of linkedItems.rows) {
          const currentItem = asInventory(row);
          if (row.status === 'Sold' && currentItem.orderId === orderId) continue;
          const item = { ...currentItem, status: 'Sold', originalQuantity: 0, reservationType: null,
            reservedUntil: null, reservedOrderId: null, soldAt: timestamp, orderId, lastUpdated: timestamp };
          await client.query(`UPDATE inventory SET status='Sold', original_quantity=0, reservation_type=NULL,
            reserved_until=NULL, reserved_order_id=NULL, data=$2::jsonb, updated_at=now() WHERE inventory_code=$1`,
          [row.inventory_code, safeJson(item)]);
        }
      } else if (['failed', 'cancelled', 'expired'].includes(paymentStatus)) {
        for (const row of linkedItems.rows) {
          if (row.reservation_type !== 'checkout_hold' || row.reserved_order_id !== orderId) continue;
          const item = { ...asInventory(row), status: 'Available', originalQuantity: 1, reservationType: null,
            reservedUntil: null, reservedOrderId: null, lastUpdated: timestamp };
          await client.query(`UPDATE inventory SET status='Available', original_quantity=1, reservation_type=NULL,
            reserved_until=NULL, reserved_order_id=NULL, data=$2::jsonb, updated_at=now() WHERE inventory_code=$1`,
          [row.inventory_code, safeJson(item)]);
        }
      }
      order.paymentStatus = paymentStatus;
      if (razorpayPaymentId) order.razorpayPaymentId = razorpayPaymentId;
      if (transactionId) order.transactionId = transactionId;
      if (paymentStatus === 'confirmed') order.confirmedAt = timestamp;
      order.updatedAt = timestamp;
      await client.query(`UPDATE orders SET payment_status=$2, razorpay_payment_id=COALESCE($3,razorpay_payment_id),
        order_data=$4::jsonb, updated_at=now() WHERE order_id=$1`, [orderId, paymentStatus, razorpayPaymentId, safeJson(order)]);
      return { success: true, order };
    });
  }

  async function cancelCheckoutReservation(orderId) {
    return updateOrderPaymentStatus(orderId, { paymentStatus: 'cancelled' });
  }

  async function updateRazorpayOrderId(orderId, razorpayOrderId) {
    const { rows } = await query(`UPDATE orders SET razorpay_order_id=$2,
      order_data=order_data || jsonb_build_object('razorpayOrderId',$2), updated_at=now()
      WHERE order_id=$1 AND razorpay_order_id IS NULL RETURNING *`, [orderId, razorpayOrderId]);
    if (!rows.length) {
      const existing = await query('SELECT * FROM orders WHERE order_id=$1', [orderId]);
      return asOrder(existing.rows[0]);
    }
    return asOrder(rows[0]);
  }

  async function purchaseOriginal({ inventoryCode }) {
    return { success: false, statusCode: 501,
      error: `Direct purchases of ${inventoryCode} require the verified checkout flow.` };
  }

  async function saveStoreTransaction() {
    throw new Error('saveStoreTransaction is unavailable with PostgreSQL; use transactional store operations.');
  }

  function resetTestStore() {
    throw new Error('PostgreSQL test reset requires an isolated test database.');
  }

  return { getInventory, getSanitizedInventory, getOrders, saveStoreTransaction, cleanExpiredReservations,
    updateOrderPaymentStatus, cancelCheckoutReservation, initializeInventory, getArtworkInventory,
    getSanitizedArtworkInventory, purchaseOriginal, commissionArtwork, createCartOrder, quoteCart,
    resetTestStore, updateRazorpayOrderId };
}

const store = createPostgresStore();
export const getInventory = store.getInventory;
export const getSanitizedInventory = store.getSanitizedInventory;
export const getOrders = store.getOrders;
export const saveStoreTransaction = store.saveStoreTransaction;
export const cleanExpiredReservations = store.cleanExpiredReservations;
export const updateOrderPaymentStatus = store.updateOrderPaymentStatus;
export const cancelCheckoutReservation = store.cancelCheckoutReservation;
export const initializeInventory = store.initializeInventory;
export const getArtworkInventory = store.getArtworkInventory;
export const getSanitizedArtworkInventory = store.getSanitizedArtworkInventory;
export const purchaseOriginal = store.purchaseOriginal;
export const commissionArtwork = store.commissionArtwork;
export const createCartOrder = store.createCartOrder;
export const quoteCart = store.quoteCart;
export const resetTestStore = store.resetTestStore;
export const updateRazorpayOrderId = store.updateRazorpayOrderId;
export { calculatePreparationTime, getAuthoritativePrice, sanitizeStorefrontItem };
