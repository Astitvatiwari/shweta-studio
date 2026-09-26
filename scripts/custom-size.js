/*
==========================================
FILE: custom-size.js
PURPOSE: Custom size selection and aspect ratio validation for paintings.
Author: Shweta Studio
==========================================
*/

export function selectPaintingSizeMode(mode) {
  const origTab = document.getElementById('tab-original-size');
  const customTab = document.getElementById('tab-custom-size');
  const origView = document.getElementById('view-original-size');
  const customView = document.getElementById('view-custom-size');
  
  if (!origTab || !customTab || !origView || !customView) return;

  if (mode === 'original') {
    origTab.style.background = 'var(--clay)';
    origTab.style.color = '#ffffff';
    origTab.style.borderColor = 'var(--clay)';
    origTab.setAttribute('aria-selected', 'true');
    
    customTab.style.background = '#ffffff';
    customTab.style.color = 'var(--charcoal)';
    customTab.style.borderColor = 'var(--line)';
    customTab.setAttribute('aria-selected', 'false');
    
    origView.style.display = 'block';
    customView.style.display = 'none';
  } else {
    customTab.style.background = 'var(--clay)';
    customTab.style.color = '#ffffff';
    customTab.style.borderColor = 'var(--clay)';
    customTab.setAttribute('aria-selected', 'true');
    
    origTab.style.background = '#ffffff';
    origTab.style.color = 'var(--charcoal)';
    origTab.style.borderColor = 'var(--line)';
    origTab.setAttribute('aria-selected', 'false');
    
    origView.style.display = 'none';
    customView.style.display = 'block';
  }
}

export function validateAndSyncDimensions(source) {
  const container = document.getElementById('view-custom-size');
  if (!container) return;

  const origWidth = parseFloat(container.getAttribute('data-orig-width'));
  const origHeight = parseFloat(container.getAttribute('data-orig-height'));
  if (!origWidth || !origHeight) return;

  const widthInput = document.getElementById('custom-width');
  const heightInput = document.getElementById('custom-height');
  const feedback = document.getElementById('aspect-ratio-feedback');
  const submitBtn = document.getElementById('btn-request-custom-size');
  if (!widthInput || !heightInput || !feedback) return;

  let width = parseFloat(widthInput.value);
  let height = parseFloat(heightInput.value);
  const origRatio = origWidth / origHeight;

  if (source === 'width') {
    if (isNaN(width) || width <= 0) {
      feedback.innerHTML = '<span style="color: var(--clay);">Please enter a valid positive width.</span>';
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.style.opacity = '0.5';
        submitBtn.style.cursor = 'not-allowed';
      }
      return;
    }
    // Automatically calculate height based on original aspect ratio
    const calculatedHeight = Math.round((width / origRatio) * 10) / 10;
    heightInput.value = calculatedHeight;
    height = calculatedHeight;
  } else if (source === 'height' && (isNaN(width) || width <= 0)) {
    if (!isNaN(height) && height > 0) {
      const calculatedWidth = Math.round((height * origRatio) * 10) / 10;
      widthInput.value = calculatedWidth;
      width = calculatedWidth;
    }
  }

  if (isNaN(width) || width <= 0 || isNaN(height) || height <= 0) {
    feedback.innerHTML = '<span style="color: var(--clay);">Please enter valid positive dimensions.</span>';
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.style.opacity = '0.5';
      submitBtn.style.cursor = 'not-allowed';
    }
    return;
  }

  const currentRatio = width / height;
  const ratioDifference = Math.abs(currentRatio - origRatio) / origRatio;
  const tolerance = 0.025; // allow minor rounding tolerance (~2.5%)

  if (ratioDifference <= tolerance) {
    feedback.innerHTML = `<span style="color: var(--sage); display: flex; align-items: center; gap: 4px;">✓ Proportions match original artwork (${origWidth} × ${origHeight} in)</span>`;
    widthInput.style.borderColor = 'var(--line)';
    heightInput.style.borderColor = 'var(--line)';
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.style.opacity = '1';
      submitBtn.style.cursor = 'pointer';
    }
  } else {
    const expectedHeight = Math.round((width / origRatio) * 10) / 10;
    feedback.innerHTML = `<span style="color: var(--clay); display: block; line-height: 1.4;">
      ⚠️ Aspect ratio must match original artwork proportions (${origWidth} × ${origHeight} in). 
      For a width of ${width}″, height should be <strong>${expectedHeight}″</strong>. 
      <a href="javascript:void(0)" onclick="syncToExpectedHeight(${expectedHeight})" style="color: var(--clay); text-decoration: underline; margin-left: 4px; font-weight: 600;">Apply ${expectedHeight}″</a>
    </span>`;
    heightInput.style.borderColor = 'var(--clay)';
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.style.opacity = '0.5';
      submitBtn.style.cursor = 'not-allowed';
    }
  }
}

export function syncToExpectedHeight(expectedHeight) {
  const heightInput = document.getElementById('custom-height');
  if (heightInput) {
    heightInput.value = expectedHeight;
    validateAndSyncDimensions('check');
  }
}

export function onCustomWidthChange(val) {
  validateAndSyncDimensions('width');
}

export function onCustomHeightChange(val) {
  validateAndSyncDimensions('height');
}

export function submitCustomSizeRequest() {
  const container = document.getElementById('view-custom-size');
  if (!container) return;

  const origWidth = container.getAttribute('data-orig-width');
  const origHeight = container.getAttribute('data-orig-height');
  const widthInput = document.getElementById('custom-width');
  const heightInput = document.getElementById('custom-height');
  const submitBtn = document.getElementById('btn-request-custom-size');

  if (submitBtn && submitBtn.disabled) return;

  const width = widthInput ? widthInput.value : '';
  const height = heightInput ? heightInput.value : '';

  const artworkTitle = window.artworkConfig?.title || "Artwork";
  const inventoryCode = window.artworkConfig?.inventoryCode || "";

  const inquiryContainer = document.getElementById('inquiry-container');
  const inquiryForm = document.getElementById('inquiry-form');
  if (inquiryContainer && inquiryForm) {
    if (inquiryForm.purpose) {
      inquiryForm.purpose.value = 'Commission';
    }
    if (inquiryForm.message) {
      inquiryForm.message.value = `I would like to request a custom size for "${artworkTitle}" (${inventoryCode}):\n- Desired Custom Dimensions: ${width} × ${height} inches (Preserving original aspect ratio)\n- Original Dimensions: ${origWidth} × ${origHeight} inches\n- Estimated Production Time: Up to 2 months\n\nPlease provide a pricing quotation and availability.`;
    }
    inquiryContainer.scrollIntoView({ behavior: 'smooth' });
    if (inquiryForm.name) {
      inquiryForm.name.focus();
    }
  }
}

// Bind to window for inline HTML onclick/oninput triggers
if (typeof window !== 'undefined') {
  window.selectPaintingSizeMode = selectPaintingSizeMode;
  window.validateAndSyncDimensions = validateAndSyncDimensions;
  window.syncToExpectedHeight = syncToExpectedHeight;
  window.onCustomWidthChange = onCustomWidthChange;
  window.onCustomHeightChange = onCustomHeightChange;
  window.submitCustomSizeRequest = submitCustomSizeRequest;
}
