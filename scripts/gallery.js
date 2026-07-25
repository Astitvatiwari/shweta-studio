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
export function swapImage(element, src) {
  const mainImage = document.getElementById('main-artwork-image');
  if (mainImage) {
    mainImage.src = src;
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
