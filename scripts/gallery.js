/*
==========================================
FILE: gallery.js
PURPOSE: Gallery image swapper for artwork detail pages.
Author: Shweta Studio
==========================================
*/

/* ==========================================
   IMAGE SWAP FUNCTIONALITY
========================================== */
export function swapImage(element, src, fallbackSrc) {
  const mainImage = document.getElementById('main-artwork-image');
  const mainSource = document.getElementById('main-artwork-source');
  
  if (mainSource && src) {
    mainSource.srcset = src;
  }
  
  if (mainImage) {
    if (fallbackSrc) {
      mainImage.dataset.fallback = fallbackSrc;
      mainImage.onerror = function() {
        if (mainSource) mainSource.srcset = '';
        if (this.dataset.fallback) this.src = this.dataset.fallback;
      };
      mainImage.src = fallbackSrc;
    } else {
      delete mainImage.dataset.fallback;
      mainImage.src = src;
    }
  }
  
  // Reset border colors on all thumbnails
  const thumbs = document.querySelectorAll('.gallery-thumb-item');
  thumbs.forEach(t => t.style.borderColor = 'var(--line)');
  
  // Highlight active thumbnail
  if (element) {
    element.style.borderColor = 'var(--clay)';
  }
}

// Expose to window object for inline HTML onclick calls
window.swapImage = swapImage;
