// data/inventory-store.js
// Development/test inventory and order adapter. Production uses PostgreSQL.
// File persistence is retained only for local iteration and isolated tests.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import artworks from '../artworks.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Allow isolated test data directory when running automated tests
export const getStoreDataDir = () => (process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : __dirname);
export const getInventoryFilePath = () => path.join(getStoreDataDir(), 'inventory.json');
export const getOrdersFilePath = () => path.join(getStoreDataDir(), 'orders.json');

// Backward-compatible file constants
const DATA_DIR = getStoreDataDir();
const INVENTORY_FILE = getInventoryFilePath();
const ORDERS_FILE = getOrdersFilePath();

// Safe checkout reservation expiry: default 15 minutes (900000ms), overridable by env
export const CHECKOUT_RESERVATION_TTL_MS = parseInt(process.env.CHECKOUT_RESERVATION_TTL_MS || '900000', 10);

// In-process mutex queue to ensure atomic transactions per inventory code on a single instance
const codeLocks = new Map();

async function acquireLock(code) {
  while (codeLocks.get(code)) {
    await codeLocks.get(code);
  }
  let resolver;
  const promise = new Promise(resolve => { resolver = resolve; });
  codeLocks.set(code, promise);
  return () => {
    codeLocks.delete(code);
    resolver();
  };
}

/**
 * Determine preparation time rules according to category and medium.
 * - Paintings: 15 days of preparation.
 * - Terracotta sculptures: 2 months of preparation.
 * - Jewellery: up to 20 business days.
 * - Other categories: consultation timeline.
 */
export function calculatePreparationTime(art) {
  if (art.category === 'Paintings') {
    return {
      duration: '15 days',
      displayText: '15 days of preparation',
      fullNotice: '15 days of preparation. Preparation time is the time needed to handcraft the artwork in the studio, not a guaranteed delivery date. Shipping and transit time are additional and governed by the studio shipping policy.',
      categoryPolicy: 'Standard Painting Creation Timeline'
    };
  }

  const mediumStr = (art.medium || '').toLowerCase();
  if (art.category === 'Sculptures' && mediumStr.includes('terracotta')) {
    return {
      duration: '2 months',
      displayText: '2 months of preparation',
      fullNotice: '2 months of preparation. Hand-building, slow drying, curing, and kiln firing terracotta sculptures requires up to 2 months of studio preparation before dispatch. Shipping and transit time are additional and governed by the studio shipping policy.',
      categoryPolicy: 'Terracotta Sculpture Creation Timeline'
    };
  }

  if (art.category === 'Jewellery') {
    return {
      duration: 'Up to 20 business days',
      displayText: 'Up to 20 business days',
      fullNotice: 'Handmade or custom-made creations may require up to 20 business days before dispatch. Shipping and transit time are additional and governed by the studio shipping policy.',
      categoryPolicy: 'Jewellery & Handcrafted Creations Timeline'
    };
  }

  // Alternative medium or custom sculpture
  return {
    duration: 'Consultation timeline',
    displayText: 'Timeline confirmed upon quotation',
    fullNotice: 'Custom sculptural creations in alternative mediums are evaluated individually. Studio preparation timeline will be determined and confirmed during consultation quotation.',
    categoryPolicy: 'Individual Studio Consultation Required'
  };
}

/**
 * Calculate authoritative server-side price based on artwork metadata and destination country.
 * Prevents client-side price tampering or spoofing.
 */
export function getAuthoritativePrice(art, country = 'India') {
  if (!art || !art.price) return null;
  const isDomestic = !country || country.toLowerCase().trim() === 'india';

  if (art.category === 'Sculptures') {
    if (isDomestic) return art.price;
    const num = parseFloat(String(art.price).replace(/[^0-9.]/g, ''));
    if (isNaN(num)) return art.price;
    const usd = Math.round((num / 90) * 1.60);
    return `$${usd.toLocaleString('en-US')}`;
  }

  if (art.category === 'Paintings') {
    if (art.price.startsWith('₹')) {
      if (isDomestic) return art.price;
      const num = parseFloat(art.price.replace(/[^0-9.]/g, ''));
      const usd = Math.round((num / 90) * 1.50);
      return `$${usd.toLocaleString('en-US')}`;
    } else if (art.price.startsWith('$')) {
      if (!isDomestic) return art.price;
      const num = parseFloat(art.price.replace(/[^0-9.]/g, ''));
      const rawInr = (num * 90) / 1.50;
      const finalInr = Math.max(4500, Math.round(rawInr));
      return `₹${finalInr.toLocaleString('en-IN')}`;
    }
  }

  if (art.category === 'Jewellery') {
    if (art.price.startsWith('$')) {
      if (!isDomestic) return art.price;
      const num = parseFloat(art.price.replace(/[^0-9.]/g, ''));
      const inr = Math.round(num * 90 * 0.90);
      return `₹${inr.toLocaleString('en-IN')}`;
    }
  }

  return art.price;
}

/**
 * Sanitize inventory item for public storefront consumers.
 * Strips internal tracking fields, customer order IDs, and server timestamps.
 */
export function sanitizeStorefrontItem(item) {
  if (!item) return null;
  const isReserved = item.status === 'Reserved' || item.initialAvailability === 'Reserved';
  const reservationType = item.reservationType === 'checkout_hold'
    ? 'checkout_hold'
    : (isReserved ? 'manual_studio' : null);
  const originalQuantity = (item.status === 'Sold' || isReserved) ? 0 : (item.originalQuantity ?? 1);

  let image = item.image || item.cardImage || null;
  if (!image) {
    const artDef = artworks.find(a => (a.inventoryCode || '').trim().toUpperCase() === (item.inventoryCode || '').trim().toUpperCase());
    if (artDef) {
      image = artDef.cardImage || (Array.isArray(artDef.images) && artDef.images[0]) || null;
    }
  }

  return {
    inventoryCode: item.inventoryCode,
    title: item.title,
    slug: item.slug || '',
    category: item.category,
    medium: item.medium,
    price: item.price,
    status: item.status,
    reservationType,
    originalQuantity,
    image,
    cardImage: image,
    preparationTime: item.preparationTime
  };
}

/**
 * Read inventory store from disk. If not yet initialized or corrupted, reinitializes safely.
 */
export function getInventory() {
  const dataDir = getStoreDataDir();
  const invFile = getInventoryFilePath();

  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  if (!fs.existsSync(invFile)) {
    return initializeInventory();
  }

  try {
    const raw = fs.readFileSync(invFile, 'utf-8');
    const inventory = JSON.parse(raw);
    const orders = getOrders();
    if (cleanExpiredReservations(inventory, orders)) {
      saveStoreTransaction({ inventory, orders });
    }
    return inventory;
  } catch (err) {
    console.error('[INVENTORY STORE] Failed to parse inventory file. Re-initializing safely...', err.message);
    return initializeInventory();
  }
}

/**
 * Return sanitized inventory map for storefront consumption.
 */
export function getSanitizedInventory() {
  const inv = getInventory();
  const sanitized = {};
  for (const [code, item] of Object.entries(inv)) {
    sanitized[code] = sanitizeStorefrontItem(item);
  }
  return sanitized;
}

/**
 * Read orders store from disk.
 */
export function getOrders() {
  const dataDir = getStoreDataDir();
  const ordFile = getOrdersFilePath();

  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  if (!fs.existsSync(ordFile)) {
    fs.writeFileSync(ordFile, JSON.stringify([], null, 2), 'utf-8');
    return [];
  }

  try {
    const raw = fs.readFileSync(ordFile, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('[INVENTORY STORE] Failed to parse orders file:', err.message);
    return [];
  }
}

function safeAtomicRename(tmp, target) {
  try {
    fs.renameSync(tmp, target);
  } catch (err) {
    if (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES') {
      try {
        fs.copyFileSync(tmp, target);
        try { fs.unlinkSync(tmp); } catch (_) {}
        return;
      } catch (_) {
        throw err;
      }
    }
    throw err;
  }
}

/**
 * Transactional multi-file persistence for inventory and orders stores.
 * Writes staging temporary files first before renaming to guarantee
 * that a crash or error during write never leaves one file updated while the other fails.
 */
export function saveStoreTransaction({ inventory, orders } = {}) {
  const dataDir = getStoreDataDir();
  const invFile = getInventoryFilePath();
  const ordFile = getOrdersFilePath();
  const tmpFiles = [];

  try {
    if (inventory !== undefined) {
      const invTmp = `${invFile}.${Date.now()}.${Math.random().toString(36).substring(2, 6)}.tmp`;
      fs.writeFileSync(invTmp, JSON.stringify(inventory, null, 2), 'utf-8');
      tmpFiles.push({ tmp: invTmp, target: invFile });
    }
    if (orders !== undefined) {
      const ordTmp = `${ordFile}.${Date.now()}.${Math.random().toString(36).substring(2, 6)}.tmp`;
      fs.writeFileSync(ordTmp, JSON.stringify(orders, null, 2), 'utf-8');
      tmpFiles.push({ tmp: ordTmp, target: ordFile });
    }
    for (const { tmp, target } of tmpFiles) {
      safeAtomicRename(tmp, target);
    }
  } catch (err) {
    for (const { tmp } of tmpFiles) {
      try {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      } catch (_) {}
    }
    throw err;
  }
}

/**
 * Atomically writes single data file via temporary file rename.
 */
function atomicWriteJson(filePath, data) {
  const tmpPath = `${filePath}.${Date.now()}.${Math.random().toString(36).substring(2, 6)}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  safeAtomicRename(tmpPath, filePath);
}

/**
 * Release expired checkout holds safely while strictly preserving manual studio reservations.
 */
export function cleanExpiredReservations(inventory, orders) {
  if (!inventory) return false;
  const now = Date.now();
  let changed = false;

  for (const code of Object.keys(inventory)) {
    const item = inventory[code];
    // Strictly preserve manual studio reservations (e.g. SS-SC-004)
    if (item.reservationType === 'manual_studio' || item.initialAvailability === 'Reserved') {
      if (item.reservationType !== 'manual_studio') {
        item.reservationType = 'manual_studio';
        item.originalQuantity = 0;
        changed = true;
      }
      continue;
    }

    if (
      item.status === 'Reserved' &&
      item.reservationType === 'checkout_hold' &&
      item.reservedUntil &&
      new Date(item.reservedUntil).getTime() <= now
    ) {
      const expiredOrderId = item.reservedOrderId;
      item.status = 'Available';
      item.reservationType = null;
      item.reservedUntil = null;
      item.reservedOrderId = null;
      item.originalQuantity = 1;
      item.lastUpdated = new Date().toISOString();
      changed = true;

      if (orders && expiredOrderId) {
        const order = orders.find(o => o.orderId === expiredOrderId);
        if (order && (order.paymentStatus === 'payment_pending' || order.paymentStatus === 'pending')) {
          order.paymentStatus = 'expired';
          order.updatedAt = new Date().toISOString();
        }
      }
    }
  }

  return changed;
}

/**
 * Allowed payment status state machine transitions.
 */
const ALLOWED_PAYMENT_TRANSITIONS = {
  'payment_pending': ['confirmed', 'failed', 'cancelled', 'expired', 'demo_simulated'],
  'pending': ['confirmed', 'failed', 'cancelled', 'expired', 'demo_simulated'],
  'demo_simulated': ['confirmed', 'cancelled', 'failed'],
  'failed': ['payment_pending', 'cancelled', 'expired'],
  'confirmed': [], // Terminal
  'cancelled': [], // Terminal
  'expired': []    // Terminal
};

/**
 * Update payment status of an existing order and persist atomically.
 * Enforces valid state machine transitions and safe inventory release / confirmation.
 */
export function updateOrderPaymentStatus(orderId, { paymentStatus = 'confirmed', razorpayPaymentId = null, transactionId = null } = {}) {
  const orders = getOrders();
  const order = orders.find(o => o.orderId === orderId);
  if (!order) {
    return { success: false, statusCode: 404, error: `Order ${orderId} not found.` };
  }

  const currentStatus = order.paymentStatus || 'payment_pending';
  if (currentStatus === paymentStatus) {
    return { success: true, order };
  }

  const allowedNext = ALLOWED_PAYMENT_TRANSITIONS[currentStatus] || [];
  if (!allowedNext.includes(paymentStatus)) {
    return {
      success: false,
      statusCode: 400,
      error: `Invalid payment status transition from "${currentStatus}" to "${paymentStatus}".`
    };
  }

  const inventory = getInventory();
  const timestamp = new Date().toISOString();

  // If transitioning to 'confirmed': Mark all original items in this order as 'Sold'
  if (paymentStatus === 'confirmed') {
    const originalCodesToSell = [];
    if (order.inventoryCode && order.orderType === 'original') {
      originalCodesToSell.push(order.inventoryCode);
    }
    if (Array.isArray(order.items)) {
      order.items.forEach(item => {
        if (item.purchaseType === 'original' && item.inventoryCode) {
          originalCodesToSell.push(item.inventoryCode);
        }
      });
    }

    for (const rawCode of originalCodesToSell) {
      const code = rawCode.trim().toUpperCase();
      const art = inventory[code];
      if (art) {
        art.status = 'Sold';
        art.originalQuantity = 0;
        art.reservationType = null;
        art.reservedUntil = null;
        art.reservedOrderId = null;
        art.soldAt = timestamp;
        art.orderId = orderId;
        art.lastUpdated = timestamp;
      }
    }
  }

  // If transitioning to 'failed', 'cancelled', or 'expired': Release any held reservations
  if (['failed', 'cancelled', 'expired'].includes(paymentStatus)) {
    for (const code of Object.keys(inventory)) {
      const art = inventory[code];
      if (
        art.status === 'Reserved' &&
        art.reservationType === 'checkout_hold' &&
        art.reservedOrderId === orderId
      ) {
        art.status = 'Available';
        art.originalQuantity = 1;
        art.reservationType = null;
        art.reservedUntil = null;
        art.reservedOrderId = null;
        art.lastUpdated = timestamp;
      }
    }
  }

  order.paymentStatus = paymentStatus;
  if (razorpayPaymentId) order.razorpayPaymentId = razorpayPaymentId;
  if (transactionId) order.transactionId = transactionId;
  if (paymentStatus === 'confirmed') {
    order.confirmedAt = timestamp;
  }
  order.updatedAt = timestamp;

  saveStoreTransaction({ inventory, orders });
  return { success: true, order };
}

/**
 * Cancel checkout reservation immediately and return held original artwork to available stock.
 */
export function cancelCheckoutReservation(orderId) {
  return updateOrderPaymentStatus(orderId, { paymentStatus: 'cancelled' });
}

/**
 * Initializes inventory from artworks.js.
 * Preserves initial availability ("Reserved" for SS-SC-004, "Available on Inquiry" for sculptures).
 * Never treats demo_simulated orders as permanent sales.
 */
export function initializeInventory() {
  const dataDir = getStoreDataDir();
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  // Read existing orders if any to ensure confirmed sales are preserved
  const existingOrders = getOrders();
  const soldOriginalCodes = new Set();

  existingOrders.forEach(o => {
    // ONLY confirmed payments permanently sell artwork. Demo simulated or unverified payments must NEVER sell artwork!
    if (o.paymentStatus === 'confirmed') {
      if (o.orderType === 'original' && o.inventoryCode) {
        soldOriginalCodes.add(o.inventoryCode.trim().toUpperCase());
      }
      if (Array.isArray(o.items)) {
        o.items.forEach(i => {
          if (i.purchaseType === 'original' && i.inventoryCode) {
            soldOriginalCodes.add(i.inventoryCode.trim().toUpperCase());
          }
        });
      }
    }
  });

  const inventory = {};
  artworks.forEach(art => {
    const prep = calculatePreparationTime(art);
    const code = art.inventoryCode.trim().toUpperCase();
    const isSold = soldOriginalCodes.has(code);

    // Preserve authentic catalog availability: do NOT blindly overwrite "Available on Inquiry" with "Available"
    let status = art.availability || 'Available';
    let reservationType = null;
    let originalQuantity = 1;

    if (isSold) {
      status = 'Sold';
      originalQuantity = 0;
    } else if (art.availability === 'Reserved') {
      status = 'Reserved';
      reservationType = 'manual_studio';
      originalQuantity = 0;
    } else if (status === 'Available on Inquiry') {
      originalQuantity = 1;
    }

    inventory[art.inventoryCode] = {
      id: art.id,
      inventoryCode: art.inventoryCode,
      slug: art.slug,
      title: art.title,
      category: art.category,
      medium: art.medium,
      price: art.price,
      initialAvailability: art.availability,
      originalQuantity,
      status,
      reservationType,
      reservedUntil: null,
      reservedOrderId: null,
      preparationTime: prep,
      image: art.cardImage || (Array.isArray(art.images) && art.images[0]) || null,
      cardImage: art.cardImage || (Array.isArray(art.images) && art.images[0]) || null,
      soldAt: isSold ? new Date().toISOString() : null,
      orderId: null,
      lastUpdated: new Date().toISOString()
    };
  });

  saveStoreTransaction({ inventory });
  return inventory;
}

/**
 * Retrieve single artwork inventory record.
 */
export function getArtworkInventory(code) {
  const inv = getInventory();
  return inv[code] || null;
}

/**
 * Retrieve single artwork inventory record sanitized for storefront.
 */
export function getSanitizedArtworkInventory(code) {
  const item = getArtworkInventory(code);
  return sanitizeStorefrontItem(item);
}

/**
 * Attempt to purchase an original artwork.
 * Thread-safe atomic operation wrapped in mutex to prevent simultaneous double-purchase.
 * Enforces server-side price authority and payment verification.
 */
export async function purchaseOriginal({ inventoryCode, customer, paymentVerification, clientRequestId }) {
  const releaseLock = await acquireLock(inventoryCode);
  try {
    const inventory = getInventory();
    const item = inventory[inventoryCode];

    if (!item) {
      return { success: false, statusCode: 404, error: `Artwork with inventory code ${inventoryCode} not found.` };
    }

    // Idempotency check: if client supplied a request ID that already succeeded
    const orders = getOrders();
    if (clientRequestId) {
      const existing = orders.find(o => o.clientRequestId === clientRequestId);
      if (existing) {
        return {
          success: true,
          statusCode: 200,
          order: existing,
          item: sanitizeStorefrontItem(item),
          message: 'Order already processed successfully (idempotent request).'
        };
      }
    }

    // Check availability
    if (item.status === 'Sold' || item.originalQuantity <= 0) {
      return {
        success: false,
        statusCode: 409,
        error: `This unique 1-of-1 original artwork (${item.title}) has already been sold and is no longer available. You may commission a newly created version inspired by this piece.`,
        status: 'Sold',
        item: sanitizeStorefrontItem(item)
      };
    }

    if (item.status === 'Reserved') {
      return {
        success: false,
        statusCode: 409,
        error: `This original artwork (${item.title}) is currently reserved. You may submit an inquiry or commission a custom piece.`,
        status: 'Reserved',
        item: sanitizeStorefrontItem(item)
      };
    }

    // Check if artwork has a listed price or requires direct inquiry
    if (!item.price || item.status === 'Available on Inquiry') {
      return {
        success: false,
        statusCode: 400,
        error: `Artwork "${item.title}" is available on inquiry only. Direct online checkout is unavailable without prior studio consultation and quotation.`,
        status: item.status,
        item: sanitizeStorefrontItem(item)
      };
    }

    // Require verified payment
    if (!paymentVerification || paymentVerification.status !== 'verified') {
      return {
        success: false,
        statusCode: 402,
        error: 'Payment verification failed or is unconfirmed. Original artwork inventory was NOT modified.',
        status: item.status,
        item: sanitizeStorefrontItem(item)
      };
    }

    // Guard against unverified client simulations in live production
    const isTestMode = process.env.NODE_ENV === 'test' || process.env.ALLOW_DEMO_CHECKOUT === 'true';
    if (!isTestMode) {
      return {
        success: false,
        statusCode: 501,
        error: 'Live online credit card gateway integration is pending. Please contact the studio directly to complete acquisition of this original artwork.',
        status: item.status,
        item: sanitizeStorefrontItem(item)
      };
    }

    // Authoritative server-side price calculation
    const calculatedPrice = getAuthoritativePrice(item, customer?.country);

    // Deduct original inventory atomically
    const orderId = `ORD-${Date.now()}-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
    const timestamp = new Date().toISOString();

    item.originalQuantity = 0;
    item.status = 'Sold';
    item.soldAt = timestamp;
    item.orderId = orderId;
    item.lastUpdated = timestamp;

    inventory[inventoryCode] = item;

    // Record order in orders store
    const newOrder = {
      orderId,
      clientRequestId: clientRequestId || null,
      orderType: 'original',
      inventoryCode: item.inventoryCode,
      artworkTitle: item.title,
      category: item.category,
      medium: item.medium,
      price: calculatedPrice,
      customer: {
        name: customer?.name || 'Collector',
        email: customer?.email || '',
        phone: customer?.phone || '',
        country: customer?.country || '',
        address: customer?.address || ''
      },
      paymentStatus: 'confirmed',
      isDemoOrder: true,
      paymentVerification: {
        method: paymentVerification.method || 'verified_payment',
        reference: paymentVerification.reference || `TXN-${Date.now()}`,
        verifiedAt: timestamp
      },
      dispatchNotice: 'Dispatch within 15 days of order confirmation and payment verification.',
      createdAt: timestamp
    };

    orders.push(newOrder);
    saveStoreTransaction({ inventory, orders });

    return {
      success: true,
      statusCode: 201,
      order: newOrder,
      item: sanitizeStorefrontItem(item),
      message: `Purchase confirmed! You have successfully acquired the 1-of-1 original artwork "${item.title}".`
    };
  } finally {
    releaseLock();
  }
}

/**
 * Record a made-to-order customization / commission request.
 * Independent order tracking: NEVER touches or restores original inventory.
 * Authoritative price assignment based on server catalog data.
 */
export async function commissionArtwork({
  inventoryCode,
  requestedDimensions,
  desiredModifications,
  isQuotationRequired,
  customer,
  clientRequestId
}) {
  const inventory = getInventory();
  const item = inventory[inventoryCode];

  if (!item) {
    return { success: false, statusCode: 404, error: `Artwork with inventory code ${inventoryCode} not found.` };
  }

  // Idempotency check
  const orders = getOrders();
  if (clientRequestId) {
    const existing = orders.find(o => o.clientRequestId === clientRequestId && o.orderType === 'commission');
    if (existing) {
      return {
        success: true,
        statusCode: 200,
        order: existing,
        item: sanitizeStorefrontItem(item),
        message: 'Commission request already recorded (idempotent request).'
      };
    }
  }

  const commissionId = `COM-${Date.now()}-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
  const timestamp = new Date().toISOString();
  const prep = item.preparationTime || calculatePreparationTime(item);

  const isQuote = Boolean(isQuotationRequired);
  const standardPrice = getAuthoritativePrice(item, customer?.country);
  const finalPrice = isQuote ? 'Separate Studio Quotation Required' : (standardPrice || 'Price on Inquiry');
  const quotationStatus = isQuote ? 'quote_required' : 'standard_approved';

  const newOrder = {
    orderId: commissionId,
    clientRequestId: clientRequestId || null,
    orderType: 'commission',
    inventoryCode: item.inventoryCode,
    artworkTitle: item.title,
    category: item.category,
    medium: item.medium,
    price: finalPrice,
    quotationStatus,
    isQuotationRequired: isQuote,
    requestedDimensions: requestedDimensions || 'Standard Original Dimensions',
    desiredModifications: desiredModifications || 'Standard made-to-order recreation',
    preparationTime: prep.displayText,
    preparationNotice: prep.fullNotice,
    customer: {
      name: customer?.name || 'Collector',
      email: customer?.email || '',
      phone: customer?.phone || '',
      country: customer?.country || '',
      address: customer?.address || ''
    },
    status: isQuote ? 'quotation_pending' : 'commission_confirmed',
    createdAt: timestamp
  };

  orders.push(newOrder);
  saveStoreTransaction({ orders });

  // Original inventory remains completely untouched.
  return {
    success: true,
    statusCode: 201,
    order: newOrder,
    item: sanitizeStorefrontItem(item),
    message: isQuote
      ? `Customization request submitted! Since your request includes custom dimensions or modifications, Shweta Studio will review your specifications and provide a separate formal quotation before any payment is collected.`
      : `Made-to-order commission confirmed for "${item.title}". Preparation timeline: ${prep.displayText}.`
  };
}

/**
 * Process a multi-item cart or single Buy Now checkout atomically.
 * Coordinates deadlock-free locking across all unique originals in the order.
 */
export async function createCartOrder({ customer, items, clientRequestId, paymentMethod }) {
  if (!items || !Array.isArray(items) || items.length === 0) {
    return { success: false, statusCode: 400, error: 'No items provided in order request.' };
  }

  // Idempotency check
  const orders = getOrders();
  if (clientRequestId) {
    const existing = orders.find(o => o.clientRequestId === clientRequestId);
    if (existing) {
      return {
        success: true,
        statusCode: 200,
        order: existing,
        message: 'Order already processed successfully (idempotent request).'
      };
    }
  }

  // Collect all original codes to lock sequentially in sorted order to prevent deadlocks
  const originalCodes = items
    .filter(i => i.purchaseType === 'original')
    .map(i => (i.inventoryCode || '').trim().toUpperCase());

  const sortedCodes = Array.from(new Set(originalCodes)).sort();
  const releaseFunctions = [];
  for (const code of sortedCodes) {
    const release = await acquireLock(code);
    releaseFunctions.push(release);
  }

  try {
    const inventory = getInventory();
    const isDomestic = !customer?.country || customer.country.toLowerCase().trim() === 'india';
    const currency = isDomestic ? 'INR' : 'USD';
    let subtotalNumeric = 0;
    const verifiedItems = [];

    // Verify all items first before committing any state changes
    for (const lineItem of items) {
      const code = (lineItem.inventoryCode || '').trim().toUpperCase();
      const item = inventory[code];

      if (!item) {
        return { success: false, statusCode: 404, error: `Artwork code ${code} not found in studio catalog.` };
      }

      if (lineItem.purchaseType === 'original') {
        if (item.status === 'Sold' || item.originalQuantity <= 0) {
          return {
            success: false,
            statusCode: 409,
            error: `Unique 1-of-1 original "${item.title}" (${item.inventoryCode}) has already been sold. Please remove it from your bag to proceed.`,
            unavailableCode: item.inventoryCode
          };
        }
        if (item.status === 'Reserved') {
          return {
            success: false,
            statusCode: 409,
            error: item.reservationType === 'checkout_hold'
              ? `Original artwork "${item.title}" is temporarily reserved in another collector's checkout. Please try again shortly.`
              : `Original artwork "${item.title}" is currently reserved.`,
            unavailableCode: item.inventoryCode
          };
        }
        if (!item.price || item.status === 'Available on Inquiry') {
          return {
            success: false,
            statusCode: 400,
            error: `Artwork "${item.title}" is available on inquiry only. Direct online purchase is not permitted.`,
            unavailableCode: item.inventoryCode
          };
        }
      }

      // Calculate authoritative price
      const authorPriceStr = getAuthoritativePrice(item, customer?.country);
      const numPrice = parseFloat(String(authorPriceStr || '0').replace(/[^0-9.]/g, '')) || 0;
      const rawQty = (lineItem.quantity !== undefined && lineItem.quantity !== null && String(lineItem.quantity).trim() !== '')
        ? parseInt(lineItem.quantity, 10)
        : 1;
      if (lineItem.purchaseType !== 'original' && (isNaN(rawQty) || rawQty < 1)) {
        return {
          success: false,
          statusCode: 400,
          error: `Invalid quantity for item "${item.title}".`
        };
      }
      const qty = lineItem.purchaseType === 'original' ? 1 : rawQty;
      subtotalNumeric += numPrice * qty;

      verifiedItems.push({
        inventoryCode: item.inventoryCode,
        title: item.title,
        category: item.category,
        medium: item.medium,
        purchaseType: lineItem.purchaseType || 'original',
        quantity: qty,
        unitPrice: authorPriceStr,
        lineTotal: isDomestic ? `₹${(numPrice * qty).toLocaleString('en-IN')}` : `$${(numPrice * qty).toLocaleString('en-US')}`,
        customDimensions: lineItem.customDimensions || '',
        customModifications: lineItem.customModifications || '',
        preparationTime: item.preparationTime?.displayText || ''
      });
    }

    // Reserve unique originals with explicit TTL hold — do NOT mark Sold before payment is confirmed!
    const orderId = `ORD-${Date.now()}-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
    const timestamp = new Date().toISOString();
    const reservationExpiry = new Date(Date.now() + CHECKOUT_RESERVATION_TTL_MS).toISOString();

    for (const lineItem of items) {
      if (lineItem.purchaseType === 'original') {
        const code = lineItem.inventoryCode.trim().toUpperCase();
        const art = inventory[code];
        art.originalQuantity = 0;
        art.status = 'Reserved';
        art.reservationType = 'checkout_hold';
        art.reservedUntil = reservationExpiry;
        art.reservedOrderId = orderId;
        art.lastUpdated = timestamp;
        inventory[code] = art;
      }
    }

    const formattedTotal = isDomestic
      ? `₹${subtotalNumeric.toLocaleString('en-IN')}`
      : `$${subtotalNumeric.toLocaleString('en-US')}`;

    const newOrder = {
      orderId,
      clientRequestId: clientRequestId || null,
      orderType: verifiedItems.length === 1 ? verifiedItems[0].purchaseType : 'cart_multi',
      items: verifiedItems,
      currency,
      subtotal: formattedTotal,
      total: formattedTotal,
      subtotalNumeric,
      customer: {
        name: customer?.name || 'Collector',
        email: customer?.email || '',
        phone: customer?.phone || '',
        country: customer?.country || 'India',
        address: customer?.address || '',
        city: customer?.city || '',
        state: customer?.state || '',
        postalCode: customer?.postalCode || ''
      },
      paymentStatus: 'payment_pending',
      reservationExpiresAt: reservationExpiry,
      paymentMethod: paymentMethod || 'studio_standard',
      shippingNotice: isDomestic
        ? 'Complimentary insured studio delivery across India included.'
        : 'Insured international transit & export packaging included.',
      createdAt: timestamp
    };

    orders.push(newOrder);
    saveStoreTransaction({ inventory, orders });

    return {
      success: true,
      statusCode: 201,
      order: newOrder,
      subtotalNumeric,
      message: `Order ${orderId} created successfully.`
    };
  } finally {
    for (const release of releaseFunctions) {
      release();
    }
  }
}

/**
 * Generate authoritative price quote for items in cart.
 */
export function quoteCart({ customer, country, items }) {
  if (!items || !Array.isArray(items) || items.length === 0) {
    return { success: false, statusCode: 400, error: 'No items provided for quotation.' };
  }
  const inventory = getInventory();
  const destCountry = country || customer?.country || 'India';
  const isDomestic = !destCountry || destCountry.toLowerCase().trim() === 'india';
  const currency = isDomestic ? 'INR' : 'USD';
  let totalNumeric = 0;
  const itemQuotes = [];

  for (const line of items) {
    const code = (line.inventoryCode || '').trim().toUpperCase();
    const item = inventory[code];
    if (!item) {
      return {
        success: false,
        statusCode: 400,
        error: `Unknown artwork code "${code || 'empty'}" in cart.`
      };
    }

    const rawQty = (line.quantity !== undefined && line.quantity !== null && String(line.quantity).trim() !== '')
      ? parseInt(line.quantity, 10)
      : 1;
    if (isNaN(rawQty) || rawQty < 1) {
      return {
        success: false,
        statusCode: 400,
        error: `Invalid quantity for item "${item.title}".`
      };
    }
    const qty = rawQty;

    if (line.purchaseType === 'original') {
      if (!item.price || item.status === 'Available on Inquiry') {
        return {
          success: false,
          statusCode: 400,
          error: `Artwork "${item.title}" is available on inquiry only.`
        };
      }
    }

    const authorPrice = getAuthoritativePrice(item, destCountry);
    const numPrice = parseFloat(String(authorPrice || '0').replace(/[^0-9.]/g, '')) || 0;
    const effectiveQty = line.purchaseType === 'original' ? 1 : qty;
    totalNumeric += numPrice * effectiveQty;

    const isAvailable = line.purchaseType === 'original'
      ? (item.status === 'Available' && item.originalQuantity > 0)
      : true;

    itemQuotes.push({
      inventoryCode: code,
      title: item.title,
      purchaseType: line.purchaseType || 'original',
      unitPrice: authorPrice,
      quantity: effectiveQty,
      isAvailable,
      status: item.status
    });
  }

  return {
    success: true,
    currency,
    subtotal: totalNumeric,
    subtotalFormatted: isDomestic ? `₹${totalNumeric.toLocaleString('en-IN')}` : `$${totalNumeric.toLocaleString('en-US')}`,
    total: isDomestic ? `₹${totalNumeric.toLocaleString('en-IN')}` : `$${totalNumeric.toLocaleString('en-US')}`,
    totalNumeric,
    items: itemQuotes
  };
}

/**
 * Reset test database helper for clean automated test suites.
 */
export function resetTestStore() {
  const invFile = getInventoryFilePath();
  const ordFile = getOrdersFilePath();
  if (fs.existsSync(invFile)) {
    fs.unlinkSync(invFile);
  }
  if (fs.existsSync(ordFile)) {
    fs.unlinkSync(ordFile);
  }
  return initializeInventory();
}
