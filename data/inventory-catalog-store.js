// Static site generation reads only public artwork metadata. It never opens the
// local order or inventory JSON files and never writes transaction state.
import artworks from '../artworks.js';
import { calculatePreparationTime, getAuthoritativePrice, sanitizeStorefrontItem } from './inventory-file-store.js';

export const CHECKOUT_RESERVATION_TTL_MS = 900000;
export const getStoreDataDir = () => null;
export const getInventoryFilePath = () => null;
export const getOrdersFilePath = () => null;

export function getInventory() {
  return Object.fromEntries(artworks.map(art => {
    const status = art.availability || 'Available';
    const reserved = status === 'Reserved';
    const image = art.cardImage || art.images?.[0] || null;
    return [art.inventoryCode, {
      inventoryCode: art.inventoryCode, id: art.id, slug: art.slug, title: art.title,
      category: art.category, medium: art.medium, price: art.price,
      initialAvailability: art.availability, status,
      originalQuantity: reserved ? 0 : 1,
      reservationType: reserved ? 'manual_studio' : null,
      reservedUntil: null, reservedOrderId: null,
      preparationTime: calculatePreparationTime(art), image, cardImage: image
    }];
  }));
}

export function getSanitizedInventory() {
  return Object.fromEntries(Object.entries(getInventory()).map(([code, item]) => [code, sanitizeStorefrontItem(item)]));
}

export function getOrders() { return []; }
export function initializeInventory() { return getInventory(); }
export function getArtworkInventory(code) { return getInventory()[String(code || '').toUpperCase()] || null; }
export function getSanitizedArtworkInventory(code) { return sanitizeStorefrontItem(getArtworkInventory(code)); }
export function quoteCart() { throw new Error('The catalog-only adapter is for static builds, not API requests.'); }
export function createCartOrder() { throw new Error('The catalog-only adapter is for static builds, not API requests.'); }
export function commissionArtwork() { throw new Error('The catalog-only adapter is for static builds, not API requests.'); }
export function purchaseOriginal() { throw new Error('The catalog-only adapter is for static builds, not API requests.'); }
export function updateOrderPaymentStatus() { throw new Error('The catalog-only adapter is for static builds, not API requests.'); }
export function cancelCheckoutReservation() { throw new Error('The catalog-only adapter is for static builds, not API requests.'); }
export function updateRazorpayOrderId() { throw new Error('The catalog-only adapter is for static builds, not API requests.'); }
export function saveStoreTransaction() { throw new Error('The catalog-only adapter cannot persist transaction data.'); }
export function cleanExpiredReservations() { return getInventory(); }
export function resetTestStore() { throw new Error('The catalog-only adapter cannot reset a transaction store.'); }
export { calculatePreparationTime, getAuthoritativePrice, sanitizeStorefrontItem };
