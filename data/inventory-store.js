// data/inventory-store.js
// Authoritative, persistent server-side store for Shweta Studio inventory and orders.
// Uses atomic file persistence to prevent race conditions and ensure durability across rebuilds.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import artworks from '../artworks.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Allow isolated test data directory when running automated tests
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : __dirname;
const INVENTORY_FILE = path.join(DATA_DIR, 'inventory.json');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');

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
  return {
    inventoryCode: item.inventoryCode,
    title: item.title,
    category: item.category,
    medium: item.medium,
    price: item.price,
    status: item.status,
    originalQuantity: item.originalQuantity,
    preparationTime: item.preparationTime
  };
}

/**
 * Read inventory store from disk. If not yet initialized or corrupted, reinitializes safely.
 */
export function getInventory() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  if (!fs.existsSync(INVENTORY_FILE)) {
    return initializeInventory();
  }

  try {
    const raw = fs.readFileSync(INVENTORY_FILE, 'utf-8');
    return JSON.parse(raw);
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
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  if (!fs.existsSync(ORDERS_FILE)) {
    fs.writeFileSync(ORDERS_FILE, JSON.stringify([], null, 2), 'utf-8');
    return [];
  }

  try {
    const raw = fs.readFileSync(ORDERS_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('[INVENTORY STORE] Failed to parse orders file:', err.message);
    return [];
  }
}

/**
 * Atomically writes data to disk via temporary file rename to prevent file corruption.
 */
function atomicWriteJson(filePath, data) {
  const tmpPath = `${filePath}.${Date.now()}.${Math.random().toString(36).substring(2, 6)}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

/**
 * Initializes inventory from artworks.js.
 * Preserves initial availability ("Reserved" for SS-SC-004, "Available on Inquiry" for sculptures).
 */
export function initializeInventory() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  // Read existing orders if any to ensure confirmed sales are preserved
  const existingOrders = getOrders();
  const soldOriginalCodes = new Set(
    existingOrders.filter(o => o.orderType === 'original' && (o.paymentStatus === 'confirmed' || o.paymentStatus === 'demo_simulated')).map(o => o.inventoryCode)
  );

  const inventory = {};
  artworks.forEach(art => {
    const prep = calculatePreparationTime(art);
    const isSold = soldOriginalCodes.has(art.inventoryCode);
    
    // Preserve authentic catalog availability: do NOT blindly overwrite "Available on Inquiry" with "Available"
    let status = art.availability || 'Available';
    if (isSold) {
      status = 'Sold';
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
      originalQuantity: status === 'Sold' ? 0 : 1,
      status: status,
      preparationTime: prep,
      soldAt: isSold ? new Date().toISOString() : null,
      orderId: null,
      lastUpdated: new Date().toISOString()
    };
  });

  atomicWriteJson(INVENTORY_FILE, inventory);
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
    atomicWriteJson(INVENTORY_FILE, inventory);

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
    atomicWriteJson(ORDERS_FILE, orders);

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
  atomicWriteJson(ORDERS_FILE, orders);

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
 * Reset test database helper for clean automated test suites.
 */
export function resetTestStore() {
  if (fs.existsSync(INVENTORY_FILE)) {
    fs.unlinkSync(INVENTORY_FILE);
  }
  if (fs.existsSync(ORDERS_FILE)) {
    fs.unlinkSync(ORDERS_FILE);
  }
  return initializeInventory();
}
