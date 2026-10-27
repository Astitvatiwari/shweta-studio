/* ==========================================
   FILE: checkout.js
   PURPOSE: Client-side checkout controller, country/currency selector,
   server quote verification, Razorpay integration, and confirmation.
   Author: Shweta Studio
========================================== */

import { getCart, clearCart, showToast, getApiBase } from './cart.js';

const API_BASE = getApiBase();

let checkoutItems = [];
let isDirectBuyNow = false;

/**
 * Initialize checkout page.
 */
export async function initCheckoutPage() {
  if (typeof document === 'undefined') return;
  const form = document.getElementById('checkout-form');
  if (!form) return;

  const urlParams = new URLSearchParams(window.location.search);
  const buyNowCode = urlParams.get('buyNow');
  const buyNowType = urlParams.get('type') || 'original';

  if (buyNowCode) {
    isDirectBuyNow = true;
    await loadDirectBuyNowItem(buyNowCode, buyNowType);
  } else {
    checkoutItems = getCart();
  }

  if (checkoutItems.length === 0) {
    renderEmptyCheckout();
    return;
  }

  // Bind country change listener to re-calculate currency
  const countrySelect = form.querySelector('[name="country"]');
  if (countrySelect) {
    countrySelect.addEventListener('change', () => {
      refreshCheckoutSummary();
    });
  }

  renderCheckoutSummary();

  form.addEventListener('submit', handleCheckoutSubmit);
}

/**
 * Load single direct Buy Now item without modifying persistent cart.
 */
async function loadDirectBuyNowItem(code, type) {
  try {
    const res = await fetch(`${API_BASE}/api/inventory/${code}`);
    if (!res.ok) {
      renderEmptyCheckout('Unable to retrieve artwork details.');
      return;
    }
    const data = await res.json();
    if (!data.success || !data.item) {
      renderEmptyCheckout('Artwork not found in catalog.');
      return;
    }

    const art = data.item;

    if (type === 'original') {
      if (art.status === 'Sold' || art.originalQuantity <= 0) {
        renderEmptyCheckout(`"${art.title}" has already been sold. You may commission a newly crafted version.`);
        return;
      }
      if (art.status === 'Reserved') {
        const isHold = art.reservationType === 'checkout_hold';
        const msg = isHold
          ? `"${art.title}" is temporarily reserved in another collector's checkout. Please check back shortly.`
          : `"${art.title}" is currently reserved. Direct online checkout is unavailable.`;
        renderEmptyCheckout(msg);
        return;
      }
      if (art.status === 'Available on Inquiry' || !art.price) {
        renderEmptyCheckout(`"${art.title}" is available on studio inquiry only. Direct online purchase is not permitted.`);
        return;
      }
    }

    const urlParams = new URLSearchParams(window.location.search);
    const requestedQty = Math.max(1, parseInt(urlParams.get('quantity') || '1', 10));
    const isOriginal = type === 'original';

    checkoutItems = [{
      id: `buynow_${art.inventoryCode}`,
      inventoryCode: art.inventoryCode,
      title: art.title,
      slug: art.slug || '',
      image: art.image || art.cardImage || '',
      category: art.category,
      medium: art.medium,
      purchaseType: type,
      quantity: isOriginal ? 1 : requestedQty,
      maxQuantity: isOriginal ? 1 : 5,
      priceInr: art.price,
      priceUsd: art.price,
      unitPrice: art.price,
      preparationTime: art.preparationTime?.displayText || ''
    }];

    const banner = document.getElementById('fast-checkout-banner');
    if (banner) {
      banner.style.display = 'block';
    }
  } catch (err) {
    console.error('[BUY NOW LOAD ERROR]', err);
    renderEmptyCheckout('Connection error retrieving artwork.');
  }
}

/**
 * Render order summary column.
 */
export function renderCheckoutSummary() {
  const container = document.getElementById('checkout-items-list');
  const subtotalEl = document.getElementById('checkout-subtotal');
  const totalEl = document.getElementById('checkout-total');
  const shippingNoteEl = document.getElementById('checkout-shipping-note');
  const currencyBadgeEl = document.getElementById('checkout-currency-badge');

  if (!container) return;

  const form = document.getElementById('checkout-form');
  const countryVal = form?.querySelector('[name="country"]')?.value || 'India';
  const isDomestic = countryVal.toLowerCase().trim() === 'india';
  const currencySymbol = isDomestic ? '₹' : '$';

  let subtotal = 0;
  let itemsHtml = '';

  checkoutItems.forEach(item => {
    // Numeric price resolution
    let numericPrice = parsePriceAmount(item, isDomestic);
    const itemTotal = numericPrice * (item.quantity || 1);
    subtotal += itemTotal;

    const formattedItemPrice = isDomestic
      ? `₹${itemTotal.toLocaleString('en-IN')}`
      : `$${itemTotal.toLocaleString('en-US')}`;

    itemsHtml += `
      <div class="checkout-item-line">
        <img src="${resolveImg(item.image)}" alt="${item.title}" class="checkout-item-thumb">
        <div style="min-width: 0;">
          <h4 style="font-family: 'Cormorant Garamond', serif; font-size: 1.1rem; margin: 0; color: var(--charcoal);">${item.title}</h4>
          <span style="font-size: 0.72rem; color: var(--muted); text-transform: uppercase;">
            ${item.inventoryCode} &bull; ${item.purchaseType === 'original' ? '1-of-1 Original' : 'Made-to-Order'}
          </span>
          <div style="font-size: 0.78rem; color: var(--muted);">Qty: ${item.quantity || 1}</div>
        </div>
        <div style="font-weight: 600; color: var(--charcoal); font-size: 0.95rem;">${formattedItemPrice}</div>
      </div>
    `;
  });

  container.innerHTML = itemsHtml;

  const formattedSubtotal = isDomestic
    ? `₹${subtotal.toLocaleString('en-IN')}`
    : `$${subtotal.toLocaleString('en-US')}`;

  if (subtotalEl) subtotalEl.innerText = formattedSubtotal;
  if (totalEl) totalEl.innerText = formattedSubtotal;
  if (currencyBadgeEl) currencyBadgeEl.innerText = isDomestic ? 'INR (₹)' : 'USD ($)';
  if (shippingNoteEl) {
    shippingNoteEl.innerText = isDomestic
      ? 'Complimentary insured studio delivery across India included.'
      : 'Insured international transit & museum export packaging included.';
  }
}

export function refreshCheckoutSummary() {
  renderCheckoutSummary();
}

function parsePriceAmount(item, isDomestic) {
  const priceStr = String(item.unitPrice || item.priceInr || item.price || '0');
  const num = parseFloat(priceStr.replace(/[^0-9.]/g, ''));
  if (isNaN(num)) return 0;

  // If sculpture in INR:
  if (item.category === 'Sculptures') {
    if (isDomestic) return num;
    return Math.round((num / 90) * 1.60);
  }

  // If paintings:
  if (item.category === 'Paintings') {
    if (priceStr.startsWith('₹')) {
      if (isDomestic) return num;
      return Math.round((num / 90) * 1.50);
    } else {
      if (!isDomestic) return num;
      return Math.max(4500, Math.round((num * 90) / 1.50));
    }
  }

  // If jewellery:
  if (item.category === 'Jewellery') {
    if (!isDomestic) return num;
    return Math.round(num * 90 * 0.90);
  }

  return num;
}

function resolveImg(src) {
  if (!src) return '';
  if (src.startsWith('http://') || src.startsWith('https://')) return src;
  return src.replace(/^\.\.\//, '');
}

function renderEmptyCheckout(message = 'Your shopping bag is empty.') {
  const container = document.getElementById('checkout-container');
  if (container) {
    container.innerHTML = `
      <div style="text-align: center; padding: 60px 20px; max-width: 500px; margin: 0 auto;">
        <h2 style="font-family: 'Cormorant Garamond', serif; font-size: 2.2rem; color: var(--charcoal); margin-bottom: 12px;">Checkout</h2>
        <p style="color: var(--muted); line-height: 1.6; margin-bottom: 24px;">${message}</p>
        <a href="works.html" class="card-btn card-btn-primary" style="padding: 12px 24px; font-size: 0.86rem; display: inline-block;">
          Browse Artwork Collections
        </a>
      </div>
    `;
  }
}

/**
 * Handle form submission and initiate real/demo payment processing.
 */
async function handleCheckoutSubmit(event) {
  event.preventDefault();
  const form = event.target;
  const submitBtn = document.getElementById('btn-submit-order');
  const statusEl = document.getElementById('checkout-status-message');

  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerText = 'Verifying Order & Inventory...';
  }
  if (statusEl) {
    statusEl.innerText = '';
    statusEl.className = 'form-status-message';
  }

  const formData = new FormData(form);
  const country = formData.get('country') || 'India';

  const payload = {
    customer: {
      name: formData.get('name')?.toString().trim(),
      email: formData.get('email')?.toString().trim(),
      phone: formData.get('phone')?.toString().trim(),
      country: country,
      address: formData.get('address')?.toString().trim(),
      city: formData.get('city')?.toString().trim(),
      state: formData.get('state')?.toString().trim(),
      postalCode: formData.get('postalCode')?.toString().trim()
    },
    items: checkoutItems.map(item => ({
      inventoryCode: item.inventoryCode,
      purchaseType: item.purchaseType || 'original',
      quantity: item.quantity || 1,
      customDimensions: item.customDimensions || '',
      customModifications: item.customModifications || '',
      isQuotationRequired: Boolean(item.isQuotationRequired)
    })),
    clientRequestId: `REQ-CHK-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    paymentMethod: formData.get('paymentMethod') || 'studio_standard'
  };

  try {
    const res = await fetch(`${API_BASE}/api/checkout/create-order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await res.json();

    if (res.status === 201 || (res.status === 200 && data.success)) {
      // Order created on server
      const order = data.order;

      // If Razorpay order returned with active live credentials
      if (data.razorpayOrderId && window.Razorpay) {
        launchRazorpayModal(data, order);
        return;
      }

      // Demo or Studio standard acquisition flow
      if (!isDirectBuyNow) {
        clearCart();
      }

      window.location.href = `order-confirmation.html?orderId=${encodeURIComponent(order.orderId)}`;
    } else if (res.status === 409) {
      if (statusEl) {
        statusEl.innerText = data.error || 'One or more items in your order are no longer available.';
        statusEl.style.color = 'var(--clay)';
      }
    } else {
      if (statusEl) {
        statusEl.innerText = data.error || 'Unable to process checkout. Please verify customer details.';
        statusEl.style.color = 'var(--clay)';
      }
    }
  } catch (err) {
    console.error('[CHECKOUT SUBMIT ERROR]', err);
    if (statusEl) {
      statusEl.innerText = 'Unable to connect to studio checkout server. Please try again or submit an inquiry directly.';
      statusEl.style.color = 'var(--clay)';
    }
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerText = 'Complete Studio Acquisition';
    }
  }
}

/**
 * Launch Razorpay standard checkout popup when keyId is present.
 */
function launchRazorpayModal(checkoutData, order) {
  const options = {
    key: checkoutData.keyId,
    amount: checkoutData.amount,
    currency: checkoutData.currency,
    name: 'Shweta Studio',
    description: `Acquisition Order ${order.orderId}`,
    image: 'all work/logo/logo with name.png',
    order_id: checkoutData.razorpayOrderId,
    modal: {
      ondismiss: async function () {
        try {
          await fetch(`${API_BASE}/api/checkout/cancel-order`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ orderId: order.orderId })
          });
        } catch (_) {}
        const statusEl = document.getElementById('checkout-status-message');
        if (statusEl) {
          statusEl.innerText = 'Payment window was closed. Your artwork reservation has been released.';
          statusEl.style.color = 'var(--muted)';
        }
      }
    },
    handler: async function (response) {
      try {
        const verifyRes = await fetch(`${API_BASE}/api/checkout/verify-payment`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            orderId: order.orderId,
            razorpayOrderId: response.razorpay_order_id,
            razorpayPaymentId: response.razorpay_payment_id,
            razorpaySignature: response.razorpay_signature
          })
        });
        const verifyData = await verifyRes.json();
        if (verifyData.success) {
          if (!isDirectBuyNow) clearCart();
          window.location.href = `order-confirmation.html?orderId=${encodeURIComponent(order.orderId)}&status=verified`;
        } else {
          alert('Payment signature verification failed: ' + verifyData.error);
        }
      } catch (e) {
        window.location.href = `order-confirmation.html?orderId=${encodeURIComponent(order.orderId)}`;
      }
    },
    prefill: {
      name: order.customer.name,
      email: order.customer.email,
      contact: order.customer.phone
    },
    theme: {
      color: '#b45f34'
    }
  };

  const rzp = new window.Razorpay(options);
  rzp.open();
}

// Auto-run on checkout page load
if (typeof window !== 'undefined') {
  window.initCheckoutPage = initCheckoutPage;
  window.refreshCheckoutSummary = refreshCheckoutSummary;
  document.addEventListener('DOMContentLoaded', () => {
    if (document.getElementById('checkout-form')) {
      initCheckoutPage();
    }
  });
}
