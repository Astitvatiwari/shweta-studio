/*
==========================================
FILE: artwork-purchasing.js
PURPOSE: Client-side handlers for One-of-One Original Purchasing & Made-to-Order Customization.
Author: Shweta Studio
==========================================
*/

import { getApiBase } from './cart.js';

const API_BASE = getApiBase();

/**
 * Open Option A — Buy Original Modal
 */
export function openOriginalPurchaseModal() {
  const modal = document.getElementById('original-purchase-modal');
  if (!modal) return;

  // Reset view to form
  const body = document.getElementById('original-purchase-body');
  const success = document.getElementById('original-purchase-success');
  const statusMsg = document.getElementById('purchase-status-message');
  if (body) body.style.display = 'block';
  if (success) success.style.display = 'none';
  if (statusMsg) {
    statusMsg.innerText = '';
    statusMsg.className = 'form-status-message';
  }

  modal.style.display = 'flex';
  document.body.style.overflow = 'hidden';

  // Live status check against server if available
  checkLiveInventoryStatus();
}

/**
 * Close Option A Modal
 */
export function closeOriginalPurchaseModal() {
  const modal = document.getElementById('original-purchase-modal');
  if (!modal) return;
  modal.style.display = 'none';
  document.body.style.overflow = '';
}

/**
 * Open Option B — Customize This Artwork Modal
 */
export function openCustomizationModal() {
  const modal = document.getElementById('customization-modal');
  if (!modal) return;

  const body = document.getElementById('customization-body');
  const success = document.getElementById('customization-success');
  const statusMsg = document.getElementById('customization-status-message');
  if (body) body.style.display = 'block';
  if (success) success.style.display = 'none';
  if (statusMsg) {
    statusMsg.innerText = '';
    statusMsg.className = 'form-status-message';
  }

  modal.style.display = 'flex';
  document.body.style.overflow = 'hidden';
}

/**
 * Close Option B Modal
 */
export function closeCustomizationModal() {
  const modal = document.getElementById('customization-modal');
  if (!modal) return;
  modal.style.display = 'none';
  document.body.style.overflow = '';
}

/**
 * Toggle between standard recreation and custom modifications
 */
export function toggleCustomFields(mode) {
  const quoteBox = document.getElementById('custom-quotation-box');
  const btn = document.getElementById('btn-submit-customization');
  
  if (mode === 'custom') {
    if (quoteBox) quoteBox.style.display = 'block';
    if (btn) btn.innerText = 'Request Custom Quotation';
  } else {
    if (quoteBox) quoteBox.style.display = 'none';
    if (btn) btn.innerText = 'Submit Customization Request';
    
    // Reset dimensions to original
    const wInput = document.getElementById('custom-req-width');
    const hInput = document.getElementById('custom-req-height');
    const origW = window.artworkConfig?.dimensions?.widthNum;
    const origH = window.artworkConfig?.dimensions?.heightNum;
    if (wInput && origW) wInput.value = origW;
    if (hInput && origH) hInput.value = origH;
  }
}

/**
 * Detect dimension modification
 */
export function onCustomReqDimChange() {
  const wInput = document.getElementById('custom-req-width');
  const hInput = document.getElementById('custom-req-height');
  const origW = window.artworkConfig?.dimensions?.widthNum;
  const origH = window.artworkConfig?.dimensions?.heightNum;

  const currentW = parseFloat(wInput?.value);
  const currentH = parseFloat(hInput?.value);

  // If dimensions changed significantly from original, automatically switch to custom mode
  if (origW && origH && (currentW !== origW || currentH !== origH)) {
    const radioCustom = document.querySelector('input[name="customMode"][value="custom"]');
    if (radioCustom && !radioCustom.checked) {
      radioCustom.checked = true;
      toggleCustomFields('custom');
    }
  }
}

/**
 * Submit Option A: Original Purchase
 */
export async function submitOriginalPurchase(event) {
  event.preventDefault();
  const form = event.target;
  const submitBtn = document.getElementById('btn-submit-purchase');
  const statusMsg = document.getElementById('purchase-status-message');

  const inventoryCode = form.inventoryCode?.value || window.artworkConfig?.inventoryCode;
  const customerName = form.customerName?.value?.trim();
  const customerEmail = form.customerEmail?.value?.trim();
  const customerPhone = form.customerPhone?.value?.trim();
  const customerCountry = form.customerCountry?.value?.trim();
  const customerAddress = form.customerAddress?.value?.trim();
  const paymentOption = form.paymentOption?.value || 'verified';

  if (!customerName || !customerEmail || !customerCountry || !customerAddress) {
    if (statusMsg) {
      statusMsg.innerText = 'Please fill out all required customer information.';
      statusMsg.style.color = 'var(--clay)';
    }
    return;
  }

  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerText = 'Verifying & Confirming Order...';
  }

  const payload = {
    inventoryCode,
    customer: {
      name: customerName,
      email: customerEmail,
      phone: customerPhone,
      country: customerCountry,
      address: customerAddress
    },
    paymentVerification: {
      status: paymentOption,
      method: paymentOption === 'verified' ? 'studio_verified_payment' : 'test_failed_payment',
      reference: `CLIENT-TX-${Date.now()}`
    },
    clientRequestId: `REQ-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`
  };

  try {
    const res = await fetch(`${API_BASE}/api/orders/original`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await res.json();

    if (res.status === 201 || (res.status === 200 && data.success)) {
      // Purchase successful
      const order = data.order;
      
      // Update DOM to Sold
      markOriginalAsSoldDOM();

      // Show receipt view
      const body = document.getElementById('original-purchase-body');
      const success = document.getElementById('original-purchase-success');
      if (body) body.style.display = 'none';
      if (success) {
        document.getElementById('receipt-order-id').innerText = order.orderId;
        document.getElementById('receipt-title').innerText = order.artworkTitle;
        document.getElementById('receipt-code').innerText = order.inventoryCode;
        document.getElementById('receipt-price').innerText = order.price || window.artworkConfig?.pricePrimary;
        document.getElementById('receipt-customer').innerText = order.customer.name;
        success.style.display = 'block';
      }
    } else if (res.status === 409) {
      // Double purchase prevention / collision
      markOriginalAsSoldDOM();
      if (statusMsg) {
        statusMsg.innerText = data.error || 'This 1-of-1 original artwork has already been sold. Please consider commissioning a made-to-order version.';
        statusMsg.style.color = 'var(--clay)';
      }
    } else {
      // Payment failure or validation error
      if (statusMsg) {
        statusMsg.innerText = data.error || 'Payment verification failed. Original inventory was NOT modified.';
        statusMsg.style.color = 'var(--clay)';
      }
    }
  } catch (err) {
    console.error('[PURCHASE ERROR]', err);
    if (statusMsg) {
      statusMsg.innerText = 'Unable to reach inventory server. If offline, inquiries can be submitted via direct inquiry.';
      statusMsg.style.color = 'var(--clay)';
    }
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerText = 'Confirm Purchase of Original';
    }
  }
}

/**
 * Submit Option B: Customization / Commission
 */
export async function submitCustomizationRequest(event) {
  event.preventDefault();
  const form = event.target;
  const submitBtn = document.getElementById('btn-submit-customization');
  const statusMsg = document.getElementById('customization-status-message');

  const inventoryCode = form.inventoryCode?.value || window.artworkConfig?.inventoryCode;
  const customMode = form.customMode?.value || 'standard';
  const requestedWidth = form.requestedWidth?.value;
  const requestedHeight = form.requestedHeight?.value;
  const modifications = form.modifications?.value?.trim() || '';
  const customerName = form.customerName?.value?.trim();
  const customerEmail = form.customerEmail?.value?.trim();
  const customerPhone = form.customerPhone?.value?.trim();
  const customerCountry = form.customerCountry?.value?.trim();

  if (!customerName || !customerEmail || !customerCountry) {
    if (statusMsg) {
      statusMsg.innerText = 'Please fill out all required customer information.';
      statusMsg.style.color = 'var(--clay)';
    }
    return;
  }

  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerText = 'Recording Request...';
  }

  const isQuotationRequired = customMode === 'custom' || modifications.length > 0;
  const requestedDimensions = (requestedWidth && requestedHeight)
    ? `${requestedWidth} × ${requestedHeight} inches`
    : (window.artworkConfig?.dimensions?.display || 'Original Proportions');

  const payload = {
    inventoryCode,
    requestedDimensions,
    desiredModifications: modifications || (isQuotationRequired ? 'Custom dimensions requested' : 'Standard made-to-order recreation'),
    isQuotationRequired,
    customer: {
      name: customerName,
      email: customerEmail,
      phone: customerPhone,
      country: customerCountry
    },
    clientRequestId: `REQ-COM-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`
  };

  try {
    const res = await fetch(`${API_BASE}/api/orders/custom`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await res.json();

    if (res.status === 201 || (res.status === 200 && data.success)) {
      const order = data.order;
      const body = document.getElementById('customization-body');
      const success = document.getElementById('customization-success');
      const subtitle = document.getElementById('custom-success-subtitle');

      if (body) body.style.display = 'none';
      if (success) {
        document.getElementById('custom-receipt-id').innerText = order.orderId;
        document.getElementById('custom-receipt-title').innerText = order.artworkTitle;
        document.getElementById('custom-receipt-dimensions').innerText = order.requestedDimensions;
        document.getElementById('custom-receipt-price').innerText = order.price;
        document.getElementById('custom-receipt-prep').innerText = order.preparationTime;
        document.getElementById('custom-receipt-status').innerText = isQuotationRequired
          ? 'Quotation Pending (Studio Review)'
          : 'Standard Commission Confirmed';

        if (subtitle) {
          subtitle.innerText = isQuotationRequired
            ? 'Your custom modification request has been submitted. Shweta Studio will provide a formal quotation before payment.'
            : 'Your made-to-order commission has been registered! Crafting will begin according to studio schedule.';
        }
        success.style.display = 'block';
      }
    } else {
      if (statusMsg) {
        statusMsg.innerText = data.error || 'Failed to record customization request.';
        statusMsg.style.color = 'var(--clay)';
      }
    }
  } catch (err) {
    console.error('[CUSTOMIZATION ERROR]', err);
    if (statusMsg) {
      statusMsg.innerText = 'Unable to reach server. Please try submitting via the general inquiry form below.';
      statusMsg.style.color = 'var(--clay)';
    }
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerText = 'Submit Customization Request';
    }
  }
}

/**
 * Update DOM elements to reflect sold original status
 */
export function markOriginalAsSoldDOM() {
  // Update badges
  const badges = document.querySelectorAll('.status-tag, #original-status-badge');
  badges.forEach(b => {
    if (b.innerText.toLowerCase().includes('available') || b.id === 'original-status-badge') {
      b.className = 'status-tag status-sold';
      b.innerText = 'Original Sold';
    }
  });

  // Disable Buy Original button
  const buyBtn = document.getElementById('btn-buy-original');
  if (buyBtn) {
    buyBtn.disabled = true;
    buyBtn.className = 'button';
    buyBtn.style.background = '#f0f0f0';
    buyBtn.style.color = '#888';
    buyBtn.style.borderColor = '#ddd';
    buyBtn.style.cursor = 'not-allowed';
    buyBtn.innerText = 'Original Sold';
  }

  // Show sold original banner
  const soldNotice = document.getElementById('sold-original-banner');
  if (soldNotice) {
    soldNotice.style.display = 'block';
  }

  // Option B "Customize This Artwork" button remains fully active!
  const custBtn = document.getElementById('btn-customize-artwork');
  if (custBtn) {
    custBtn.disabled = false;
  }
}

/**
 * Query live server for real-time inventory status
 */
export async function checkLiveInventoryStatus() {
  const code = window.artworkConfig?.inventoryCode;
  if (!code) return;

  try {
    const res = await fetch(`${API_BASE}/api/inventory/${code}`);
    if (!res.ok) return;
    const data = await res.json();
    if (data.success && data.item) {
      if (data.item.status === 'Sold') {
        markOriginalAsSoldDOM();
      }
    }
  } catch (e) {
    // Graceful offline fallback
  }
}

// Bind handlers to window object for inline HTML event triggers
if (typeof window !== 'undefined') {
  window.openOriginalPurchaseModal = openOriginalPurchaseModal;
  window.closeOriginalPurchaseModal = closeOriginalPurchaseModal;
  window.openCustomizationModal = openCustomizationModal;
  window.closeCustomizationModal = closeCustomizationModal;
  window.toggleCustomFields = toggleCustomFields;
  window.onCustomReqDimChange = onCustomReqDimChange;
  window.submitOriginalPurchase = submitOriginalPurchase;
  window.submitCustomizationRequest = submitCustomizationRequest;
  window.markOriginalAsSoldDOM = markOriginalAsSoldDOM;

  // Check live status on load
  document.addEventListener('DOMContentLoaded', () => {
    checkLiveInventoryStatus();

    // Close modals on escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeOriginalPurchaseModal();
        closeCustomizationModal();
      }
    });

    // Close modals when clicking backdrop
    const origModal = document.getElementById('original-purchase-modal');
    if (origModal) {
      origModal.addEventListener('click', (e) => {
        if (e.target === origModal) closeOriginalPurchaseModal();
      });
    }
    const custModal = document.getElementById('customization-modal');
    if (custModal) {
      custModal.addEventListener('click', (e) => {
        if (e.target === custModal) closeCustomizationModal();
      });
    }
  });
}
