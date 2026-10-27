/* ==========================================
   FILE: cart.js
   PURPOSE: Persistent shopping cart engine, cart drawer,
   toast notifications, and collection card purchase handlers.
   Author: Shweta Studio
========================================== */

const CART_STORAGE_KEY = 'shweta_studio_cart_v1';

export function getApiBase() {
  if (typeof window === 'undefined') return '';
  const { protocol, hostname, port } = window.location;
  if (protocol === 'file:') return 'http://localhost:3000';
  const isLocal = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0' || hostname === '[::1]' || hostname.endsWith('.local');
  if (isLocal) {
    return port === '3000' ? '' : `${protocol}//${hostname}:3000`;
  }
  return '';
}

const API_BASE = getApiBase();

/**
 * Retrieve current cart items from localStorage.
 */
export function getCart() {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(CART_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (err) {
    console.error('[CART] Failed to parse cart from storage:', err);
    return [];
  }
}

/**
 * Persist cart items to localStorage and notify UI components.
 */
export function saveCart(cart) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(cart));
    updateCartBadges();
    window.dispatchEvent(new CustomEvent('cart:updated', { detail: { cart } }));
  } catch (err) {
    console.error('[CART] Failed to save cart:', err);
  }
}

/**
 * Add an item to the shopping cart.
 * Prevents duplicate lines for unique 1-of-1 originals.
 */
export function addToCart(item, openDrawer = true) {
  const cart = getCart();
  const isOriginal = item.purchaseType === 'original';

  // 1-of-1 Original artwork check: Cannot add duplicate original
  if (isOriginal) {
    const existingOriginal = cart.find(
      i => i.inventoryCode === item.inventoryCode && i.purchaseType === 'original'
    );
    if (existingOriginal) {
      if (item.image && existingOriginal.image !== item.image) {
        existingOriginal.image = item.image;
        saveCart(cart);
      }
      showToast(`This unique 1-of-1 original ("${item.title}") is already in your cart.`, 'View Cart', () => openCartDrawer());
      return false;
    }
  }

  // Check if identical item already exists (e.g. stocked jewellery or identical commission)
  const existingIndex = cart.findIndex(i => {
    if (i.inventoryCode !== item.inventoryCode || i.purchaseType !== item.purchaseType) {
      return false;
    }
    if (item.purchaseType === 'commission') {
      return i.customDimensions === item.customDimensions && i.customModifications === item.customModifications;
    }
    return true;
  });

  if (existingIndex > -1 && !isOriginal) {
    const max = cart[existingIndex].maxQuantity || 5;
    const addQty = item.quantity || 1;
    cart[existingIndex].quantity = Math.min(cart[existingIndex].quantity + addQty, max);
  } else {
    cart.push({
      id: `${item.inventoryCode}_${item.purchaseType}_${Date.now()}`,
      inventoryCode: item.inventoryCode,
      title: item.title,
      slug: item.slug,
      image: item.image,
      category: item.category,
      medium: item.medium,
      purchaseType: item.purchaseType || 'original',
      quantity: isOriginal ? 1 : (item.quantity || 1),
      maxQuantity: isOriginal ? 1 : (item.maxQuantity || 5),
      priceInr: item.priceInr || item.price,
      priceUsd: item.priceUsd || item.price,
      unitPrice: item.unitPrice || item.price,
      customDimensions: item.customDimensions || '',
      customModifications: item.customModifications || '',
      isQuotationRequired: Boolean(item.isQuotationRequired),
      preparationTime: item.preparationTime || ''
    });
  }

  saveCart(cart);
  showToast(`"${item.title}" added to your cart.`, 'View Cart', () => openCartDrawer());

  if (openDrawer) {
    openCartDrawer();
  }

  return true;
}

/**
 * Remove an item from the cart by its line item id.
 */
export function removeFromCart(itemId) {
  let cart = getCart();
  const target = cart.find(i => i.id === itemId);
  cart = cart.filter(i => i.id !== itemId);
  saveCart(cart);
  if (target) {
    showToast(`"${target.title}" removed from cart.`);
  }
  renderCartDrawerContent();
}

/**
 * Update the quantity of an item in the cart.
 * Unique originals are strictly locked to quantity 1.
 */
export function updateCartQuantity(itemId, newQty) {
  const cart = getCart();
  const item = cart.find(i => i.id === itemId);
  if (!item) return;

  if (item.purchaseType === 'original') {
    item.quantity = 1;
  } else {
    const qty = parseInt(newQty, 10);
    const max = item.maxQuantity || 5;
    if (qty <= 0) {
      removeFromCart(itemId);
      return;
    }
    item.quantity = Math.min(Math.max(1, qty), max);
  }

  saveCart(cart);
  renderCartDrawerContent();
}

/**
 * Clear all items from the cart.
 */
export function clearCart() {
  saveCart([]);
  renderCartDrawerContent();
}

/**
 * Count total items in the cart.
 */
export function getCartCount() {
  const cart = getCart();
  return cart.reduce((sum, item) => sum + (item.quantity || 1), 0);
}

/**
 * Update live item count badges in header navigation.
 */
export function updateCartBadges() {
  if (typeof document === 'undefined') return;
  const count = getCartCount();
  const badges = document.querySelectorAll('#cart-item-count, .cart-badge');
  badges.forEach(badge => {
    badge.innerText = count;
    badge.style.display = count > 0 ? 'inline-flex' : 'none';
    badge.classList.remove('bump');
    // Trigger CSS bump animation
    void badge.offsetWidth;
    if (count > 0) {
      badge.classList.add('bump');
    }
  });
}


/**
 * Create or open the slide-out Cart Drawer.
 */
export function openCartDrawer() {
  ensureCartDrawerInDOM();
  const backdrop = document.getElementById('studio-cart-drawer-backdrop');
  if (backdrop) {
    renderCartDrawerContent();
    backdrop.classList.add('is-open');
    document.body.style.overflow = 'hidden';
  }
}

/**
 * Close the slide-out Cart Drawer.
 */
export function closeCartDrawer() {
  const backdrop = document.getElementById('studio-cart-drawer-backdrop');
  if (backdrop) {
    backdrop.classList.remove('is-open');
    document.body.style.overflow = '';
  }
}

export function toggleCartDrawer() {
  const backdrop = document.getElementById('studio-cart-drawer-backdrop');
  if (backdrop && backdrop.classList.contains('is-open')) {
    closeCartDrawer();
  } else {
    openCartDrawer();
  }
}

/**
 * Inject cart drawer backdrop and container into DOM if not present.
 */
function ensureCartDrawerInDOM() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('studio-cart-drawer-backdrop')) return;

  const drawerHtml = `
    <div id="studio-cart-drawer-backdrop" class="cart-drawer-backdrop" role="dialog" aria-modal="true" aria-label="Shopping Cart Drawer">
      <div class="cart-drawer">
        <div class="cart-drawer-header">
          <div>
            <span style="font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.1em; color: var(--clay); font-weight: 600; display: block;">Studio Collection</span>
            <h3>Shopping Bag</h3>
          </div>
          <button type="button" class="cart-drawer-close" onclick="window.closeCartDrawer()" aria-label="Close cart">&times;</button>
        </div>
        <div id="cart-drawer-body" class="cart-drawer-body"></div>
        <div id="cart-drawer-footer" class="cart-drawer-footer"></div>
      </div>
    </div>
  `;
  document.body.insertAdjacentHTML('beforeend', drawerHtml);

  // Close on backdrop click
  const backdrop = document.getElementById('studio-cart-drawer-backdrop');
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) {
      closeCartDrawer();
    }
  });
}

/**
 * Render the inner contents of the slide-out Cart Drawer.
 */
export function renderCartDrawerContent() {
  const body = document.getElementById('cart-drawer-body');
  const footer = document.getElementById('cart-drawer-footer');
  if (!body || !footer) return;

  const cart = getCart();

  if (cart.length === 0) {
    body.innerHTML = `
      <div class="cart-drawer-empty">
        <svg class="cart-empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"></path>
          <line x1="3" y1="6" x2="21" y2="6"></line>
          <path d="M16 10a4 4 0 0 1-8 0"></path>
        </svg>
        <h4 style="font-family: 'Cormorant Garamond', serif; font-size: 1.4rem; font-weight: 400; margin: 0; color: var(--charcoal);">Your studio cart is empty</h4>
        <p style="font-size: 0.82rem; color: var(--muted); line-height: 1.5; margin: 0;">Explore our collection of authentic 1-of-1 terracotta sculptures, fine art paintings, and handmade jewellery.</p>
        <a href="${getRelativeUrl('works.html')}" class="card-btn card-btn-primary" style="margin-top: 10px; padding: 10px 20px; font-size: 0.82rem;" onclick="window.closeCartDrawer()">
          Explore Collections
        </a>
      </div>
    `;
    footer.style.display = 'none';
    return;
  }

  footer.style.display = 'flex';

  let itemsHtml = '';
  cart.forEach(item => {
    const isOriginal = item.purchaseType === 'original';
    const tagClass = isOriginal ? 'cart-tag-original' : (item.purchaseType === 'commission' ? 'cart-tag-custom' : 'cart-tag-stocked');
    const tagLabel = isOriginal ? '1-of-1 Original' : (item.purchaseType === 'commission' ? 'Made-to-Order' : 'Handmade');
    const imgPath = resolveImagePath(item.image);

    itemsHtml += `
      <div class="cart-item-card">
        <img src="${imgPath}" alt="${item.title}" class="cart-item-thumb" onerror="window.handleCartImageError && window.handleCartImageError(this, '${item.inventoryCode}')">
        <div class="cart-item-details">
          <h4 class="cart-item-title">${item.title}</h4>
          <span class="cart-item-meta">${item.inventoryCode} &bull; ${item.medium || item.category}</span>
          <span class="cart-item-tag ${tagClass}">${tagLabel}</span>
          ${item.customDimensions ? `<span style="font-size: 0.72rem; color: var(--muted); margin-top: 2px;">${item.customDimensions}</span>` : ''}
          <div class="cart-item-price">${item.unitPrice || item.priceInr || item.price}</div>
        </div>
        <div class="cart-item-controls">
          ${isOriginal ? `
            <span style="font-size: 0.75rem; font-weight: 600; color: var(--clay); background: #f4efe9; padding: 3px 8px; border-radius: 4px;" title="Unique physical 1-of-1 piece">Qty: 1</span>
          ` : `
            <div class="qty-control">
              <button type="button" class="qty-btn" onclick="window.updateCartQuantity('${item.id}', ${item.quantity - 1})" aria-label="Decrease quantity">&minus;</button>
              <span class="qty-num">${item.quantity}</span>
              <button type="button" class="qty-btn" onclick="window.updateCartQuantity('${item.id}', ${item.quantity + 1})" aria-label="Increase quantity" ${item.quantity >= (item.maxQuantity || 5) ? 'disabled' : ''}>&plus;</button>
            </div>
          `}
          <button type="button" class="cart-item-remove" onclick="window.removeFromCart('${item.id}')">Remove</button>
        </div>
      </div>
    `;
  });

  body.innerHTML = itemsHtml;

  footer.innerHTML = `
    <div style="font-size: 0.76rem; color: var(--sage); line-height: 1.4; background: rgba(92, 99, 88, 0.08); padding: 8px 12px; border-radius: 4px;">
      &check; <strong>Studio Guarantee:</strong> Authenticity certificate & insured museum packaging included.
    </div>
    <div class="cart-drawer-actions">
      <a href="${getRelativeUrl('checkout.html')}" class="btn-checkout-drawer">
        Proceed to Checkout
      </a>
      <a href="${getRelativeUrl('cart.html')}" class="btn-view-cart-drawer">
        View Detailed Bag (${cart.length} ${cart.length === 1 ? 'piece' : 'pieces'})
      </a>
    </div>
  `;
}

/**
 * Display a floating art-gallery toast notification.
 */
export function showToast(message, actionLabel, actionCallback) {
  if (typeof document === 'undefined') return;
  let toast = document.getElementById('studio-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'studio-toast';
    toast.className = 'studio-toast';
    document.body.appendChild(toast);
  }

  toast.innerHTML = `
    <span class="studio-toast-icon">&#10003;</span>
    <span>${message}</span>
    ${actionLabel ? `<button type="button" class="studio-toast-btn" id="studio-toast-action">${actionLabel}</button>` : ''}
  `;

  if (actionLabel && actionCallback) {
    const btn = document.getElementById('studio-toast-action');
    if (btn) {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        actionCallback();
        toast.classList.remove('show');
      });
    }
  }

  toast.classList.add('show');

  if (window.studioToastTimer) clearTimeout(window.studioToastTimer);
  window.studioToastTimer = setTimeout(() => {
    toast.classList.remove('show');
  }, 4000);
}

/**
 * Helper to resolve relative URL based on whether caller is in /pieces/ subfolder or root.
 */
function getRelativeUrl(targetPath) {
  const isInPieces = typeof window !== 'undefined' && window.location.pathname.includes('/pieces/');
  return isInPieces ? `../${targetPath}` : targetPath;
}

export function resolveImagePath(imgPath) {
  if (!imgPath) return '';
  const isInPieces = typeof window !== 'undefined' && window.location.pathname.includes('/pieces/');
  if (imgPath.startsWith('http://') || imgPath.startsWith('https://')) return imgPath;
  if (imgPath.startsWith('../')) {
    return isInPieces ? imgPath : imgPath.substring(3);
  }
  return isInPieces ? `../${imgPath}` : imgPath;
}

/**
 * Auto-heal cart thumbnail on image error.
 * If an image fails to load (e.g. from legacy stale localStorage data),
 * fetch authoritative artwork info from inventory API and update src + storage.
 */
export async function handleCartImageError(imgElem, inventoryCode) {
  if (!imgElem || !inventoryCode || imgElem.dataset.healed) return;
  imgElem.dataset.healed = 'true';
  try {
    const res = await fetch(`${API_BASE}/api/inventory/${encodeURIComponent(inventoryCode)}`);
    if (!res.ok) return;
    const data = await res.json();
    if (data.success && data.item) {
      const canonical = (data.item.image || data.item.cardImage || '').replace(/^\.\.\//, '');
      if (canonical) {
        const resolved = resolveImagePath(canonical);
        imgElem.src = resolved;
        const cart = getCart();
        const target = cart.find(i => i.inventoryCode === inventoryCode);
        if (target) {
          target.image = canonical;
          saveCart(cart);
        }
      }
    }
  } catch (_) {}
}

/**
 * Card click handler: Add to Cart from collection card.
 * Server is strictly authoritative for purchase eligibility.
 */
export async function handleCardAddToCart(inventoryCode, purchaseType = 'original', event) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }

  const cleanCode = (inventoryCode || '').trim().toUpperCase();
  if (!cleanCode) return;

  try {
    const res = await fetch(`${API_BASE}/api/inventory/${encodeURIComponent(cleanCode)}`);
    if (!res.ok) {
      let errorMsg = `Unable to verify artwork status for ${cleanCode}.`;
      try {
        const errData = await res.json();
        if (errData && errData.error) errorMsg = errData.error;
      } catch (_) {}
      showToast(errorMsg);
      return;
    }
    const data = await res.json();
    if (!data.success || !data.item) {
      showToast(`Artwork ${cleanCode} not found.`);
      return;
    }

    const art = data.item;

    if (purchaseType === 'original') {
      // 1. Sold check
      if (art.status === 'Sold' || art.originalQuantity <= 0) {
        showToast(`This original piece has already been sold. You may commission a made-to-order version.`, 'Customize', () => {
          window.location.href = getRelativeUrl(`pieces/${art.slug || cleanCode.toLowerCase()}.html#customize`);
        });
        return;
      }

      // 2. Reserved check (manual studio vs temporary checkout hold)
      if (art.status === 'Reserved') {
        const isHold = art.reservationType === 'checkout_hold';
        if (isHold) {
          showToast(`Original artwork "${art.title}" is temporarily reserved in another checkout. Please check back shortly.`);
        } else {
          showToast(`Original artwork "${art.title}" is currently reserved. You may submit an inquiry.`, 'Inquire', () => {
            window.location.href = getRelativeUrl(`pieces/${art.slug || cleanCode.toLowerCase()}.html#inquiry-container`);
          });
        }
        return;
      }

      // 3. Inquiry-only check
      if (art.status === 'Available on Inquiry' || !art.price) {
        showToast(`"${art.title}" is available on studio inquiry only. Direct online purchase is not permitted.`, 'Inquire', () => {
          window.location.href = getRelativeUrl(`pieces/${art.slug || cleanCode.toLowerCase()}.html#inquiry-container`);
        });
        return;
      }
    }

    const canonicalImage = (art.image || art.cardImage || '').replace(/^\.\.\//, '');
    addToCart({
      inventoryCode: art.inventoryCode,
      title: art.title,
      slug: art.slug || '',
      image: canonicalImage,
      category: art.category,
      medium: art.medium,
      purchaseType,
      unitPrice: art.price,
      priceInr: art.price,
      preparationTime: art.preparationTime?.displayText || ''
    }, true);
  } catch (err) {
    console.error('[CARD ADD TO CART]', err);
    showToast(`Verification service unavailable. Please check your connection and try again.`);
  }
}

/**
 * Card click handler: Fast-path Buy Now.
 * Server is strictly authoritative for purchase eligibility.
 */
export async function handleCardBuyNow(inventoryCode, purchaseType = 'original', event) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }

  const cleanCode = (inventoryCode || '').trim().toUpperCase();
  if (!cleanCode) return;

  try {
    const res = await fetch(`${API_BASE}/api/inventory/${encodeURIComponent(cleanCode)}`);
    if (!res.ok) {
      let errorMsg = `Unable to verify artwork status for ${cleanCode}.`;
      try {
        const errData = await res.json();
        if (errData && errData.error) errorMsg = errData.error;
      } catch (_) {}
      showToast(errorMsg);
      return;
    }
    const data = await res.json();
    if (!data.success || !data.item) {
      showToast(`Artwork ${cleanCode} not found in catalog.`);
      return;
    }
    const art = data.item;

    if (purchaseType === 'original') {
      // 1. Sold check
      if (art.status === 'Sold' || art.originalQuantity <= 0) {
        showToast(`This original piece has already been sold. You may commission a made-to-order piece.`, 'Customize', () => {
          window.location.href = getRelativeUrl(`pieces/${art.slug || cleanCode.toLowerCase()}.html#customize`);
        });
        return;
      }

      // 2. Reserved check
      if (art.status === 'Reserved') {
        const isHold = art.reservationType === 'checkout_hold';
        if (isHold) {
          showToast(`Original artwork "${art.title}" is temporarily reserved in another checkout. Please check back shortly.`);
        } else {
          showToast(`Original artwork "${art.title}" is currently reserved. You may submit an inquiry.`, 'Inquire', () => {
            window.location.href = getRelativeUrl(`pieces/${art.slug || cleanCode.toLowerCase()}.html#inquiry-container`);
          });
        }
        return;
      }

      // 3. Inquiry-only check
      if (art.status === 'Available on Inquiry' || !art.price) {
        showToast(`"${art.title}" is available on studio inquiry only. Direct online purchase is not permitted.`, 'Inquire', () => {
          window.location.href = getRelativeUrl(`pieces/${art.slug || cleanCode.toLowerCase()}.html#inquiry-container`);
        });
        return;
      }
    }

    // Fast-path to checkout ONLY after authoritative status verified!
    window.location.href = getRelativeUrl(`checkout.html?buyNow=${encodeURIComponent(cleanCode)}&type=${encodeURIComponent(purchaseType)}`);
  } catch (err) {
    console.error('[CARD BUY NOW]', err);
    showToast(`Verification service unavailable. Please check your connection and try again.`);
  }
}

// Bind to window object for inline HTML event handlers
if (typeof window !== 'undefined') {
  window.getCart = getCart;
  window.addToCart = addToCart;
  window.removeFromCart = removeFromCart;
  window.updateCartQuantity = updateCartQuantity;
  window.clearCart = clearCart;
  window.openCartDrawer = openCartDrawer;
  window.closeCartDrawer = closeCartDrawer;
  window.toggleCartDrawer = toggleCartDrawer;
  window.showToast = showToast;
  window.handleCardAddToCart = handleCardAddToCart;
  window.handleCardBuyNow = handleCardBuyNow;
  window.handleCartImageError = handleCartImageError;
  window.resolveImagePath = resolveImagePath;

  document.addEventListener('DOMContentLoaded', () => {
    updateCartBadges();
    ensureCartDrawerInDOM();

    // Wire header cart button to open drawer smoothly if not on cart page
    const cartBtn = document.getElementById('header-cart-btn');
    if (cartBtn) {
      cartBtn.addEventListener('click', (e) => {
        if (!window.location.pathname.endsWith('cart.html')) {
          e.preventDefault();
          openCartDrawer();
        }
      });
    }

    // Close on Escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeCartDrawer();
      }
    });
  });
}
