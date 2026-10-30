// Select the durable adapter explicitly in production. File persistence remains
// available only for local development and isolated regression tests.
const storageMode = process.env.STORAGE_BACKEND || '';
const usePostgres = storageMode === 'postgres';

if (process.env.NODE_ENV === 'production' && !usePostgres && storageMode !== 'catalog') {
  throw new Error('Production requires STORAGE_BACKEND=postgres; JSON persistence is disabled.');
}

const store = usePostgres
  ? await import('./inventory-postgres-store.js')
  : storageMode === 'catalog'
    ? await import('./inventory-catalog-store.js')
    : await import('./inventory-file-store.js');

export const calculatePreparationTime = store.calculatePreparationTime;
export const getAuthoritativePrice = store.getAuthoritativePrice;
export const sanitizeStorefrontItem = store.sanitizeStorefrontItem;
export const getStoreDataDir = store.getStoreDataDir;
export const getInventoryFilePath = store.getInventoryFilePath;
export const getOrdersFilePath = store.getOrdersFilePath;
export const CHECKOUT_RESERVATION_TTL_MS = store.CHECKOUT_RESERVATION_TTL_MS;
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
