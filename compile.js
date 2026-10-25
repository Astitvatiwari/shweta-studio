import fs from 'fs';
import path from 'path';
import artworks from './artworks.js';
import { getInventory, calculatePreparationTime } from './data/inventory-store.js';

// Read persistent authoritative inventory store (does not reset sold items upon rebuild)
const inventoryStore = getInventory();

const DETAIL_TEMPLATE_PATH = './pieces/detail_template.html';
const OUTPUT_DIR = './pieces';
const TEMPLATE_DIR = './templates';

// Ensure output directory exists
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// 1. Define standard header and footer blocks
const headerHtml = `<header class="site-header">
      <a class="brand" href="index.html" aria-label="SHWETA STUDIO home">
        <img src="all work/logo/logo with name.png" alt="Shweta Studio Logo" loading="eager" class="header-logo">
      </a>
      <button class="menu-toggle" type="button" aria-expanded="false" aria-controls="site-nav">Menu</button>
      <nav class="site-nav" id="site-nav" aria-label="Primary navigation">
        <a href="index.html" id="nav-home-link">Home</a>
        <div class="nav-dropdown-wrapper">
          <a href="works.html" id="nav-collections-link">Collections</a>
          <div class="nav-dropdown">
            <a href="sculptures.html">Sculptures</a>
            <a href="paintings.html">Paintings</a>
            <a href="jewellery.html">Jewellery &  Handmade Creations</a>
          </div>
        </div>
        <a href="story.html" id="nav-story-link">Story</a>
        <a href="engagements.html" id="nav-engagements-link">Public Engagements</a>
        <a href="contact.html" id="nav-contact-link">Contact</a>
      </nav>
      <div class="header-tools">
        <a class="tool-link" href="works.html">View Collections</a>
        <a class="tool-link-cart" href="cart.html" id="header-cart-btn" aria-label="Shopping Cart">
          <svg class="cart-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="21" r="1"></circle><circle cx="20" cy="21" r="1"></circle><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"></path></svg>
          <span class="cart-text">Cart</span>
          <span class="cart-badge" style="display:none;">0</span>
        </a>
        <a class="tool-link tool-link-filled" href="contact.html">Inquire</a>
      </div>
    </header>`;

const footerHtml = `<footer class="site-footer">
      <div class="footer-copyright-block">
        <div style="margin-bottom: 12px;">
          <img src="all work/logo/logo with name.png" alt="Shweta Studio Logo" loading="lazy" style="width: 160px; height: auto; display: block;">
        </div>
        <p>Artist: Shweta Jain Maheshwari</p>
        <p style="font-size: 0.72rem; color: var(--muted); margin-top: 6px; line-height: 1.5; max-width: 500px;">
          &copy; 2026 Shweta Studio. All artworks, photographs, text, and visual content are protected by copyright. Unauthorized reproduction or commercial use is prohibited.
        </p>
      </div>
      <span>
        <a href="commission.html" style="margin-right: 15px;">Commission</a>
        <a href="faq.html" style="margin-right: 15px;">FAQ</a>
        <a href="works.html">Collections</a>
      </span>
    </footer>`;

// 2. Validate header and footer strings before replacement
if (typeof headerHtml !== 'string' || headerHtml.length === 0) {
  console.error('[FATAL] headerHtml must be a valid non-empty string.');
  process.exit(1);
}

if (typeof footerHtml !== 'string' || footerHtml.length === 0) {
  console.error('[FATAL] footerHtml must be a valid non-empty string.');
  process.exit(1);
}

console.log('Starting compilation. Found ' + artworks.length + ' artworks.');

// 3. Rank and retrieve related works based on category -> medium -> price range
function getRelatedWorks(artwork, allArtworks) {
  let candidates = allArtworks.filter(a => a.id !== artwork.id);
  
  return candidates
    .map(a => {
      let score = 0;
      if (a.category === artwork.category) {
        score += 100;
        if (a.medium === artwork.medium) score += 20;
        if (a.price && artwork.price) {
          const p1 = parseFloat(a.price.replace(/[^0-9.]/g, ''));
          const p2 = parseFloat(artwork.price.replace(/[^0-9.]/g, ''));
          if (!isNaN(p1) && !isNaN(p2)) {
            score += Math.max(0, 10 - Math.abs(p1 - p2) / 20);
          }
        }
      }
      return { item: a, score: score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(x => x.item);
}

// Get optimized WebP path
function getWebpPath(originalPath, sizeSuffix = 'medium') {
  const dir = path.dirname(originalPath);
  const ext = path.extname(originalPath);
  const base = path.basename(originalPath, ext);
  return `${dir}/${base}_${sizeSuffix}.webp`;
}

// Centralized Currency & Pricing Configuration
const INR_TO_USD_RATE = 90;
const INTL_PREMIUM_MULTIPLIER = 1.50;

const MINIMUM_INR_PRICE = 4500;

function calculateIntlUsdPrice(inrPriceStr) {
  if (!inrPriceStr) return null;
  const num = parseFloat(inrPriceStr.replace(/[^0-9.]/g, ''));
  if (isNaN(num)) return null;
  const usd = Math.round((num / INR_TO_USD_RATE) * INTL_PREMIUM_MULTIPLIER);
  return `$${usd.toLocaleString('en-US')}`;
}

function calculateDomesticInrPrice(usdPriceStr) {
  if (!usdPriceStr) return null;
  const num = parseFloat(usdPriceStr.replace(/[^0-9.]/g, ''));
  if (isNaN(num)) return null;
  const rawInr = (num * INR_TO_USD_RATE) / INTL_PREMIUM_MULTIPLIER;
  const finalInr = Math.max(MINIMUM_INR_PRICE, Math.round(rawInr));
  return `₹${finalInr.toLocaleString('en-IN')}`;
}

const JEWELLERY_DEPRECIATION_FACTOR = 0.90;

function calculateJewelleryInrPrice(usdPriceStr) {
  if (!usdPriceStr) return null;
  const num = parseFloat(usdPriceStr.replace(/[^0-9.]/g, ''));
  if (isNaN(num)) return null;
  const inr = Math.round(num * INR_TO_USD_RATE * JEWELLERY_DEPRECIATION_FACTOR);
  return `₹${inr.toLocaleString('en-IN')}`;
}

const SCULPTURE_INTL_MULTIPLIER = 1.60;
const SCULPTURE_INTL_PREMIUM_MULTIPLIER = SCULPTURE_INTL_MULTIPLIER;

function calculateSculptureIntlUsdPrice(inrPriceStr) {
  if (!inrPriceStr) return null;
  const num = parseFloat(String(inrPriceStr).replace(/[^0-9.]/g, ''));
  if (isNaN(num)) return null;
  const usd = Math.round((num / INR_TO_USD_RATE) * SCULPTURE_INTL_MULTIPLIER);
  return `$${usd.toLocaleString('en-US')}`;
}

const calculateSculptureUsdPrice = calculateSculptureIntlUsdPrice;

export {
  INR_TO_USD_RATE,
  INTL_PREMIUM_MULTIPLIER,
  calculateIntlUsdPrice,
  calculateDomesticInrPrice,
  JEWELLERY_DEPRECIATION_FACTOR,
  calculateJewelleryInrPrice,
  SCULPTURE_INTL_MULTIPLIER,
  SCULPTURE_INTL_PREMIUM_MULTIPLIER,
  calculateSculptureIntlUsdPrice,
  calculateSculptureUsdPrice
};

function parseDimensionValue(str) {
  if (!str) return null;
  const match = str.toString().match(/([0-9.]+)\s*(inches|inch|feet|ft|cm)?/i);
  if (!match) return null;
  let val = parseFloat(match[1]);
  const unit = (match[2] || 'inches').toLowerCase();
  if (unit === 'feet' || unit === 'ft') val *= 12;
  else if (unit === 'cm') val /= 2.54;
  return Math.round(val * 10) / 10;
}

const INCLUDED_DELIVERY_SKUS = new Set([
  'SS-PT-013',
  'SS-PT-014',
  'SS-PT-015',
  'SS-PT-016',
  'SS-PT-017',
  'SS-PT-018',
  'SS-PT-019',
  'SS-PT-020'
]);

const OLDER_PAINTING_SKUS = new Set([
  'SS-PT-001',
  'SS-PT-002',
  'SS-PT-003',
  'SS-PT-004',
  'SS-PT-005',
  'SS-PT-006',
  'SS-PT-007',
  'SS-PT-008',
  'SS-PT-009',
  'SS-PT-010',
  'SS-PT-011',
  'SS-PT-012'
]);

// Keep track of sitemap links
const sitemapLinks = [];

/**
 * Render consistent e-commerce action buttons on collection cards.
 * Complies with strict inventory rules:
 * - Direct purchasable: Buy Now + Add to Bag + View
 * - Sold unique original: Sold (disabled) + Customize + View
 * - Available on inquiry / unpriced: Inquire Now + Details
 */
function renderCardActions(art, cardStatus) {
  const isDirectPurchasable = Boolean(art.price && art.availability !== 'Available on Inquiry');
  const isSold = cardStatus === 'Sold';
  const isReserved = cardStatus === 'Reserved';

  if (!isDirectPurchasable) {
    return `
          <div class="card-action-bar inquiry-only">
            <a href="pieces/${art.slug}.html#inquiry-container" class="card-btn card-btn-primary" style="width: 100%;">Inquire Now</a>
            <a href="pieces/${art.slug}.html" class="card-btn card-btn-text">Details</a>
          </div>`;
  }

  if (isSold) {
    return `
          <div class="card-action-bar sold-out">
            <span class="card-btn card-btn-secondary" style="cursor: not-allowed; opacity: 0.65; background: #f5f5f5;">Sold</span>
            <a href="pieces/${art.slug}.html#customization-modal" class="card-btn card-btn-primary">Customize</a>
            <a href="pieces/${art.slug}.html" class="card-btn card-btn-text">View</a>
          </div>`;
  }

  if (isReserved) {
    return `
          <div class="card-action-bar sold-out">
            <span class="card-btn card-btn-secondary" style="cursor: not-allowed; opacity: 0.65; background: #f5f5f5;">Reserved</span>
            <a href="pieces/${art.slug}.html#customization-modal" class="card-btn card-btn-primary">Customize</a>
            <a href="pieces/${art.slug}.html" class="card-btn card-btn-text">View</a>
          </div>`;
  }

  const purchaseType = art.category === 'Jewellery' ? 'stocked' : 'original';
  return `
          <div class="card-action-bar">
            <button type="button" class="card-btn card-btn-primary" onclick="event.preventDefault(); event.stopPropagation(); handleCardBuyNow('${art.inventoryCode}', '${purchaseType}', event)">Buy Now</button>
            <button type="button" class="card-btn card-btn-secondary" onclick="event.preventDefault(); event.stopPropagation(); handleCardAddToCart('${art.inventoryCode}', '${purchaseType}', event)">Add to Bag</button>
            <a href="pieces/${art.slug}.html" class="card-btn card-btn-text">View</a>
          </div>`;
}

// 4. Compile each artwork detail page from pieces/detail_template.html
if (!fs.existsSync(DETAIL_TEMPLATE_PATH)) {
  console.error(`[FATAL] Missing detail template file at: ${DETAIL_TEMPLATE_PATH}`);
  process.exit(1);
}

const detailTemplate = fs.readFileSync(DETAIL_TEMPLATE_PATH, 'utf-8');

// List of required template tags in detail page
const requiredDetailTags = [
  '{{TITLE}}', '{{SLUG}}', '{{CATEGORY}}', '{{INVENTORY_CODE}}', 
  '{{MEDIUM}}', '{{DIMENSIONS}}', '{{WEIGHT}}', 
  '{{PACKAGING}}', '{{FRAGILE}}', '{{PRICE_DISPLAY}}', 
  '{{DESCRIPTION}}', '{{MAIN_IMAGE}}', '{{STATUS}}', 
  '{{STATUS_CLASS}}', '{{BACK_LINK}}', '{{BACK_TEXT}}', 
  '{{THUMBNAIL_GALLERY}}', '{{RELATED_WORKS}}', '{{META_TITLE}}', 
  '{{META_DESCRIPTION}}', '{{SCHEMA_JSON}}', '{{SHIPPING_NOTICE}}', '{{ARTIST}}',
  '{{FEATURED_BADGE}}', '{{ARTIST_INFO}}', '{{OG_IMAGE}}', '{{IMAGE_ALT}}',
  '{{ORIGINAL_PRICE_PRIMARY}}', '{{PREPARATION_TIME_DISPLAY}}', '{{PREPARATION_TIME_NOTICE}}',
  '{{ORIG_WIDTH_NUM}}', '{{ORIG_HEIGHT_NUM}}'
];

// Check all required tags in template before rendering
requiredDetailTags.forEach(tag => {
  if (!detailTemplate.includes(tag)) {
    console.error(`[FATAL] Missing required placeholder tag '${tag}' in detail_template.html`);
    process.exit(1);
  }
});

artworks.forEach(art => {
  console.log('Compiling [' + art.inventoryCode + '] - ' + art.title + '...');

  if (!art.slug || !art.title || !art.category || !art.images || art.images.length === 0) {
    console.error('[ERROR] Missing required metadata fields for ID: ' + art.id);
    process.exit(1);
  }

  const artistName = art.artist || 'Shweta Jain Maheshwari';

  // Related works block (rendered at compile time for static page)
  const related = getRelatedWorks(art, artworks);
  let relatedHtml = '';
  related.forEach(rel => {
    const imgMedium = getWebpPath(rel.images[0], 'medium');
    let priceInfo = '';
    if (rel.category === 'Sculptures') {
      if (rel.price) {
        const usdPrice = calculateSculptureIntlUsdPrice(rel.price);
        priceInfo = `<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 6px; padding: 6px 8px; background: #fafafa; border: 1px solid var(--line); border-radius: var(--radius);">
                <div>
                  <span style="font-size: 0.65rem; text-transform: uppercase; color: var(--muted); letter-spacing: 0.06em; font-weight: 600; display: block;">India</span>
                  <strong style="font-size: 0.95rem; font-weight: 600; color: var(--clay); display: block; line-height: 1.2; margin: 2px 0;">${rel.price}</strong>
                </div>
                <div>
                  <span style="font-size: 0.65rem; text-transform: uppercase; color: var(--muted); letter-spacing: 0.06em; font-weight: 600; display: block;">Worldwide</span>
                  <strong style="font-size: 0.95rem; font-weight: 600; color: var(--clay); display: block; line-height: 1.2; margin: 2px 0;">${usdPrice}</strong>
                </div>
              </div>`;
      } else {
        priceInfo = `<strong style="font-size: 0.95rem; color: var(--muted); font-weight: 500;">Available on Inquiry</strong>`;
      }
    } else if (INCLUDED_DELIVERY_SKUS.has(rel.inventoryCode)) {
      const usdPrice = calculateIntlUsdPrice(rel.price);
      priceInfo = `
              <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 6px; padding: 6px 8px; background: #fafafa; border: 1px solid var(--line); border-radius: var(--radius);">
                <div>
                  <span style="font-size: 0.65rem; text-transform: uppercase; color: var(--muted); letter-spacing: 0.06em; font-weight: 600; display: block;">India</span>
                  <strong style="font-size: 0.95rem; font-weight: 600; color: var(--clay); display: block; line-height: 1.2; margin: 2px 0;">${rel.price}</strong>
                  <span style="font-size: 0.65rem; color: var(--sage); font-weight: 500; display: block; line-height: 1.2;">Domestic delivery included</span>
                </div>
                <div>
                  <span style="font-size: 0.65rem; text-transform: uppercase; color: var(--muted); letter-spacing: 0.06em; font-weight: 600; display: block;">Worldwide</span>
                  <strong style="font-size: 0.95rem; font-weight: 600; color: var(--clay); display: block; line-height: 1.2; margin: 2px 0;">${usdPrice}</strong>
                  <span style="font-size: 0.65rem; color: var(--sage); font-weight: 500; display: block; line-height: 1.2;">International delivery included</span>
                </div>
              </div>`;
    } else if (OLDER_PAINTING_SKUS.has(rel.inventoryCode)) {
      const inrPrice = calculateDomesticInrPrice(rel.price);
      priceInfo = `
              <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 6px; padding: 6px 8px; background: #fafafa; border: 1px solid var(--line); border-radius: var(--radius);">
                <div>
                  <span style="font-size: 0.65rem; text-transform: uppercase; color: var(--muted); letter-spacing: 0.06em; font-weight: 600; display: block;">India</span>
                  <strong style="font-size: 0.95rem; font-weight: 600; color: var(--clay); display: block; line-height: 1.2; margin: 2px 0;">${inrPrice}</strong>
                  <span style="font-size: 0.65rem; color: var(--sage); font-weight: 500; display: block; line-height: 1.2;">Domestic delivery included</span>
                </div>
                <div>
                  <span style="font-size: 0.65rem; text-transform: uppercase; color: var(--muted); letter-spacing: 0.06em; font-weight: 600; display: block;">Worldwide</span>
                  <strong style="font-size: 0.95rem; font-weight: 600; color: var(--clay); display: block; line-height: 1.2; margin: 2px 0;">${rel.price}</strong>
                  <span style="font-size: 0.65rem; color: var(--sage); font-weight: 500; display: block; line-height: 1.2;">International delivery included</span>
                </div>
              </div>`;
    } else if (rel.category === 'Jewellery') {
      const inrPrice = calculateJewelleryInrPrice(rel.price);
      priceInfo = `
              <div style="margin-top: 4px;">
                <strong style="font-size: 1.05rem; font-weight: 600; color: var(--clay); display: block; line-height: 1.2;">${inrPrice}</strong>
                <span style="font-size: 0.85rem; font-weight: 500; color: var(--muted); display: block; margin-top: 2px;">${rel.price}</span>
              </div>`;
    } else {
      priceInfo = `<strong style="font-size: 1.15rem; color: var(--clay); font-weight: 600;">${rel.price}</strong>`;
    }
    relatedHtml += `
        <article class="collection-card" style="grid-column: span 1; background: #ffffff;">
          <a href="${rel.slug}.html" style="text-decoration: none; color: inherit; display: grid;">
            <div class="image-swap" style="aspect-ratio: 4/5; border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; background: #fafafa; position: relative;">
               <img class="image-primary" src="../${imgMedium}" alt="${rel.title} — original ${rel.medium.toLowerCase()} by ${rel.artist || 'Shweta Jain Maheshwari'}" style="width: 100%; height: 100%; object-fit: contain; display: block;" loading="lazy">
            </div>
            <div class="piece-copy" style="padding: 15px 0;">
              <span style="font-size: 0.72rem; text-transform: uppercase; color: var(--muted); letter-spacing: 0.08em; display: block; margin-bottom: 4px;">${rel.category}</span>
              <h4 style="font-size: 1.15rem; font-weight: 500; margin: 0 0 6px; color: var(--charcoal);">${rel.title}</h4>
              ${priceInfo}
            </div>
          </a>
        </article>`;
  });

  // Thumbnail strip block
  let thumbHtml = '';
  if (art.images.length > 1) {
    thumbHtml += `<div class="thumbnail-gallery-container" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(80px, 1fr)); gap: 10px; margin-top: 10px;">`;
    art.images.forEach((img, idx) => {
      const imgThumb = getWebpPath(img, 'thumb');
      const imgMedium = getWebpPath(img, 'medium');
      const borderStyle = idx === 0 ? 'border: 2px solid var(--clay);' : 'border: 1px solid var(--line);';
      const altText = (art.imageAlts && art.imageAlts[idx]) ? art.imageAlts[idx] : `${art.title} — view ${idx+1} by ${artistName}`;
      if (art.slug === 'sharabha-the-cosmic-subduer-of-narasimha') {
        const encodedThumb = encodeURI(imgThumb);
        const encodedMedium = encodeURI(imgMedium);
        const encodedFallback = encodeURI(img);
        thumbHtml += `
            <div class="gallery-thumb-item" style="border-radius: 4px; overflow: hidden; aspect-ratio: 1; cursor: pointer; ${borderStyle} transition: border-color 0.24s;" onclick="swapImage(this, '../${encodedMedium}', '../${encodedFallback}')">
              <picture style="width: 100%; height: 100%; display: block;">
                <source srcset="../${encodedThumb}" type="image/webp">
                <img src="../${encodedFallback}" onerror="const s=this.previousElementSibling; if(s)s.srcset=''; this.src='../${encodedFallback}';" alt="${altText}" style="width: 100%; height: 100%; object-fit: cover;" loading="lazy">
              </picture>
            </div>`;
      } else {
        thumbHtml += `
            <div class="gallery-thumb-item" style="border-radius: 4px; overflow: hidden; aspect-ratio: 1; cursor: pointer; ${borderStyle} transition: border-color 0.24s;" onclick="swapImage(this, '../${imgMedium}')">
              <img src="../${imgThumb}" alt="${altText}" style="width: 100%; height: 100%; object-fit: cover;" loading="lazy">
            </div>`;
      }
    });
    thumbHtml += `</div>`;
  }

  // Back links
  let backLink = '../works.html';
  let backText = 'Collections';
  if (art.category === 'Sculptures') {
    backLink = '../sculptures.html';
    backText = 'Sculptures';
  } else if (art.category === 'Paintings') {
    backLink = '../paintings.html';
    backText = 'Paintings';
  } else if (art.category === 'Jewellery') {
    backLink = '../jewellery.html';
    backText = 'Jewellery &  Handmade Creations';
  }

  // Persistent authoritative inventory status check
  const invItem = inventoryStore[art.inventoryCode] || {};
  const currentStatus = invItem.status || art.availability;
  const isSold = currentStatus === 'Sold';
  const isReserved = currentStatus === 'Reserved';
  const prepTime = calculatePreparationTime(art);

  const origW = parseDimensionValue(art.dimensions?.width) || 12;
  const origH = parseDimensionValue(art.dimensions?.height) || 12;

  let primaryPrice = art.price || 'Available on Inquiry';
  let pricingBoxesHtml = '';

  if (art.category === 'Sculptures') {
    if (art.price) {
      const usdPrice = calculateSculptureIntlUsdPrice(art.price);
      primaryPrice = `${art.price} (India) / ${usdPrice} (Worldwide)`;
      pricingBoxesHtml = `
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px;">
              <div style="background: #fafafa; border: 1px solid var(--line); border-radius: var(--radius); padding: 14px 16px;">
                <span style="font-size: 0.74rem; text-transform: uppercase; color: var(--muted); letter-spacing: 0.08em; font-weight: 600; display: block; margin-bottom: 4px;">India</span>
                <div style="font-size: 1.6rem; color: var(--clay); font-weight: 600; line-height: 1.2;">${art.price}</div>
              </div>
              <div style="background: #fafafa; border: 1px solid var(--line); border-radius: var(--radius); padding: 14px 16px;">
                <span style="font-size: 0.74rem; text-transform: uppercase; color: var(--muted); letter-spacing: 0.08em; font-weight: 600; display: block; margin-bottom: 4px;">Worldwide</span>
                <div style="font-size: 1.6rem; color: var(--clay); font-weight: 600; line-height: 1.2;">${usdPrice}</div>
              </div>
            </div>`;
    } else {
      primaryPrice = 'Price on Inquiry';
      pricingBoxesHtml = `<strong style="font-size: 1.8rem; color: var(--clay); font-weight: 500;">Price available upon request</strong>`;
    }
  } else if (art.category === 'Paintings') {
    if (INCLUDED_DELIVERY_SKUS.has(art.inventoryCode)) {
      const usdPrice = calculateIntlUsdPrice(art.price);
      primaryPrice = `${art.price} (India) / ${usdPrice} (Worldwide)`;
      pricingBoxesHtml = `
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px;">
              <div style="background: #fafafa; border: 1px solid var(--line); border-radius: var(--radius); padding: 14px 16px;">
                <span style="font-size: 0.74rem; text-transform: uppercase; color: var(--muted); letter-spacing: 0.08em; font-weight: 600; display: block; margin-bottom: 4px;">India</span>
                <div style="font-size: 1.6rem; color: var(--clay); font-weight: 600; line-height: 1.2;">${art.price}</div>
                <span style="font-size: 0.78rem; color: var(--sage); font-weight: 500; display: block; margin-top: 5px;">Domestic delivery included</span>
              </div>
              <div style="background: #fafafa; border: 1px solid var(--line); border-radius: var(--radius); padding: 14px 16px;">
                <span style="font-size: 0.74rem; text-transform: uppercase; color: var(--muted); letter-spacing: 0.08em; font-weight: 600; display: block; margin-bottom: 4px;">Worldwide</span>
                <div style="font-size: 1.6rem; color: var(--clay); font-weight: 600; line-height: 1.2;">${usdPrice}</div>
                <span style="font-size: 0.78rem; color: var(--sage); font-weight: 500; display: block; margin-top: 5px;">International delivery included</span>
              </div>
            </div>`;
    } else if (OLDER_PAINTING_SKUS.has(art.inventoryCode)) {
      const inrPrice = calculateDomesticInrPrice(art.price);
      primaryPrice = `${inrPrice} (India) / ${art.price} (Worldwide)`;
      pricingBoxesHtml = `
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px;">
              <div style="background: #fafafa; border: 1px solid var(--line); border-radius: var(--radius); padding: 14px 16px;">
                <span style="font-size: 0.74rem; text-transform: uppercase; color: var(--muted); letter-spacing: 0.08em; font-weight: 600; display: block; margin-bottom: 4px;">India</span>
                <div style="font-size: 1.6rem; color: var(--clay); font-weight: 600; line-height: 1.2;">${inrPrice}</div>
                <span style="font-size: 0.78rem; color: var(--sage); font-weight: 500; display: block; margin-top: 5px;">Domestic delivery included</span>
              </div>
              <div style="background: #fafafa; border: 1px solid var(--line); border-radius: var(--radius); padding: 14px 16px;">
                <span style="font-size: 0.74rem; text-transform: uppercase; color: var(--muted); letter-spacing: 0.08em; font-weight: 600; display: block; margin-bottom: 4px;">Worldwide</span>
                <div style="font-size: 1.6rem; color: var(--clay); font-weight: 600; line-height: 1.2;">${art.price}</div>
                <span style="font-size: 0.78rem; color: var(--sage); font-weight: 500; display: block; margin-top: 5px;">International delivery included</span>
              </div>
            </div>`;
    } else {
      primaryPrice = art.price;
      pricingBoxesHtml = `<strong style="font-size: 1.8rem; color: var(--clay); font-weight: 500;">${art.price}</strong>`;
    }
  } else if (art.category === 'Jewellery') {
    const inrPrice = calculateJewelleryInrPrice(art.price);
    primaryPrice = `${inrPrice} / ${art.price}`;
    pricingBoxesHtml = `
          <div style="display: flex; flex-direction: column; gap: 2px;">
            <strong style="font-size: 1.8rem; color: var(--clay); font-weight: 600; line-height: 1.2;">${inrPrice}</strong>
            <span style="font-size: 1.15rem; color: var(--muted); font-weight: 500;">${art.price}</span>
          </div>`;
  } else {
    primaryPrice = art.price;
    pricingBoxesHtml = `<strong style="font-size: 1.8rem; color: var(--clay); font-weight: 500;">${art.price}</strong>`;
  }

  // Presentation Block based on artwork type:
  // 1. Inquiry-only products (Available on inquiry / unpriced sculptures)
  // 2. Multi-unit stock (Jewellery)
  // 3. Unique physical originals (Paintings, priced sculptures like SS-SC-002)
  const isDirectPurchasable = Boolean(art.price && art.availability !== 'Available on Inquiry');
  const isJewellery = art.category === 'Jewellery';

  let purchaseOptionsBlock = '';

  if (!isDirectPurchasable) {
    purchaseOptionsBlock = `
          <div class="purchase-options-wrapper">
            <div style="background: #fafafa; border: 1px solid var(--line); border-radius: var(--radius); padding: 24px; text-align: center; display: grid; gap: 12px;">
              <span class="status-tag status-available" style="margin: 0 auto; padding: 4px 12px; font-size: 0.76rem;">Available on Inquiry</span>
              <h4 style="font-family: 'Cormorant Garamond', serif; font-size: 1.6rem; font-weight: 500; margin: 0; color: var(--charcoal);">Acquisition via Gallery Inquiry</h4>
              <p style="font-size: 0.86rem; color: var(--muted); line-height: 1.6; max-width: 520px; margin: 0 auto;">
                This sculptural creation is handcrafted individually and presented through studio inquiry. Inquire below to receive pricing, custom specifications, or international shipping quotations.
              </p>
              <div style="display: flex; justify-content: center; gap: 12px; margin-top: 6px;">
                <a href="#inquiry-container" class="button button-primary" style="padding: 10px 24px; border-radius: 4px; font-weight: 600; text-transform: uppercase; font-size: 0.78rem; text-decoration: none;">Inquire Now</a>
                <a href="../contact.html" class="button button-secondary" style="padding: 10px 24px; border-radius: 4px; font-weight: 500; font-size: 0.78rem; text-decoration: none;">Contact Studio</a>
              </div>
            </div>
          </div>`;
  } else if (isJewellery) {
    purchaseOptionsBlock = `
          <div class="purchase-options-wrapper">
            <div style="background: #fafafa; border: 1px solid var(--line); border-radius: var(--radius); padding: 22px; display: grid; gap: 14px;">
              <div style="display: flex; justify-content: space-between; align-items: center;">
                <span style="font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 600; color: var(--clay);">Handmade Studio Creation</span>
                <span class="status-tag status-available" style="margin: 0; font-size: 0.68rem; padding: 2px 8px;">In Stock</span>
              </div>
              <div>
                <div style="font-size: 1.45rem; font-weight: 600; color: var(--clay);">${primaryPrice}</div>
                <p style="font-size: 0.82rem; color: var(--muted); margin: 4px 0 0; line-height: 1.45;">Handmade jewellery piece. Individual creations may feature natural material variations. Dispatched in studio packaging.</p>
              </div>
              <div style="display: flex; align-items: center; gap: 10px;">
                <label for="jewellery-qty-picker" style="font-size: 0.76rem; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 600; color: var(--muted);">Quantity:</label>
                <select id="jewellery-qty-picker" style="padding: 6px 12px; border: 1px solid var(--line); border-radius: 4px; font-family: inherit; font-size: 0.86rem; background: #ffffff;">
                  <option value="1">1</option>
                  <option value="2">2</option>
                  <option value="3">3</option>
                  <option value="4">4</option>
                  <option value="5">5</option>
                </select>
              </div>
              <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
                <button type="button" class="button button-primary" onclick="const q = parseInt(document.getElementById('jewellery-qty-picker')?.value || 1, 10); window.location.href = '../checkout.html?buyNow=${art.inventoryCode}&type=stocked&quantity=' + q;" style="border-radius: 4px; font-weight: 600; text-transform: uppercase; font-size: 0.78rem; padding: 11px;">Buy Now</button>
                <button type="button" class="button button-secondary" onclick="const q = parseInt(document.getElementById('jewellery-qty-picker')?.value || 1, 10); for(let i=0; i<q; i++){ handleCardAddToCart('${art.inventoryCode}', 'stocked', event); }" style="border-radius: 4px; font-weight: 600; text-transform: uppercase; font-size: 0.78rem; padding: 11px; border-color: var(--clay); color: var(--clay);">Add to Bag</button>
              </div>
            </div>
          </div>`;
  } else {
    // Unique 1-of-1 Original Artworks (Paintings & Priced Sculptures)
    const originalStatusTagText = isSold ? 'Original Sold' : (isReserved ? 'Original Reserved' : 'Original Available &bull; 1/1 Unique Piece');
    const originalButtonHtml = isSold
      ? `<button type="button" class="button" disabled style="width: 100%; border-radius: 4px; font-weight: 600; cursor: not-allowed; letter-spacing: 0.06em; text-transform: uppercase; background: #f0f0f0; color: #888; border: 1px solid #ddd; font-size: 0.78rem;">Original Sold</button>`
      : (isReserved
        ? `<button type="button" class="button" disabled style="width: 100%; border-radius: 4px; font-weight: 600; cursor: not-allowed; letter-spacing: 0.06em; text-transform: uppercase; background: #f0f0f0; color: #888; border: 1px solid #ddd; font-size: 0.78rem;">Original Reserved</button>`
        : `<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
            <button type="button" class="button button-primary" id="btn-buy-original" onclick="handleCardBuyNow('${art.inventoryCode}', 'original', event)" style="width: 100%; border-radius: 4px; font-weight: 600; cursor: pointer; letter-spacing: 0.06em; text-transform: uppercase; font-size: 0.76rem; padding: 10px 6px;">Buy Original</button>
            <button type="button" class="button button-secondary" id="btn-add-original-cart" onclick="handleCardAddToCart('${art.inventoryCode}', 'original', event)" style="width: 100%; border-radius: 4px; font-weight: 600; cursor: pointer; letter-spacing: 0.06em; text-transform: uppercase; font-size: 0.76rem; padding: 10px 6px; border-color: var(--clay); color: var(--clay);">Add to Bag</button>
          </div>`);

    purchaseOptionsBlock = `
          <!-- Two Separate Options on Every Artwork Page (Option A & Option B) -->
          <div class="purchase-options-wrapper">
            <div class="purchase-options-grid">
              <!-- Option A: Buy Original -->
              <div class="option-card option-card-original">
                <div>
                  <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; margin-bottom: 8px;">
                    <span style="font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 600; color: var(--clay);">Option A</span>
                    <span id="original-status-badge" class="status-tag ${isSold ? 'status-sold' : (isReserved ? 'status-sold' : 'status-available')}" style="margin: 0; font-size: 0.68rem; padding: 2px 8px;">${originalStatusTagText}</span>
                  </div>
                  <h4 style="font-family: 'Cormorant Garamond', serif; font-size: 1.32rem; font-weight: 500; margin: 0 0 6px; color: var(--charcoal);">1-of-1 Physical Original</h4>
                  <div style="font-size: 1.05rem; font-weight: 600; color: ${isSold ? 'var(--muted)' : 'var(--clay)'}; margin-bottom: 6px;">
                    ${isSold ? `<span style="text-decoration: line-through; opacity: 0.6;">${primaryPrice}</span> <span style="font-size: 0.82rem; color: var(--clay); text-decoration: none; font-weight: 500; margin-left: 6px;">Sold</span>` : primaryPrice}
                  </div>
                  <p style="font-size: 0.78rem; color: var(--muted); line-height: 1.45; margin: 0;">
                    ${isSold ? 'The authentic original physical piece has been sold to a private collection.' : `Authentic 1/1 physical original piece crafted by ${artistName}. Signed Certificate of Authenticity included.`}
                  </p>
                </div>
                <div>
                  ${originalButtonHtml}
                </div>
              </div>

              <!-- Option B: Customize This Artwork -->
              <div class="option-card option-card-custom">
                <div>
                  <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; margin-bottom: 8px;">
                    <span style="font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 600; color: var(--sage);">Option B</span>
                    <span class="status-tag status-available" style="margin: 0; font-size: 0.68rem; padding: 2px 8px; background: rgba(92, 99, 88, 0.12); color: var(--sage);">Made-to-Order</span>
                  </div>
                  <h4 style="font-family: 'Cormorant Garamond', serif; font-size: 1.32rem; font-weight: 500; margin: 0 0 6px; color: var(--charcoal);">Customize This Artwork</h4>
                  <div style="font-size: 1.05rem; font-weight: 600; color: var(--clay); margin-bottom: 4px;">
                    ${primaryPrice} <span style="font-size: 0.74rem; color: var(--muted); font-weight: 400;">(Standard Version)</span>
                  </div>
                  <div style="display: flex; align-items: center; gap: 5px; font-size: 0.76rem; color: var(--charcoal); margin-bottom: 6px;">
                    <span style="color: var(--clay);">⏱</span>
                    <span><strong>Preparation Time:</strong> ${prepTime.displayText}</span>
                  </div>
                  <p style="font-size: 0.78rem; color: var(--muted); line-height: 1.45; margin: 0;">
                    Request a newly created, made-to-order version inspired by this artwork. Handcrafted individually with natural variations in materials and texture.
                  </p>
                </div>
                <div>
                  <button type="button" class="button button-secondary" id="btn-customize-artwork" onclick="openCustomizationModal()" style="width: 100%; border-radius: 4px; font-weight: 600; cursor: pointer; letter-spacing: 0.06em; text-transform: uppercase; border-color: var(--clay); color: var(--clay); font-size: 0.78rem;">Customize This Artwork</button>
                </div>
              </div>
            </div>
          </div>`;
  }

  const soldBannerHtml = `
        <div id="sold-original-banner" class="sold-original-banner" style="${isSold ? 'display: grid;' : 'display: none;'}">
          <strong style="color: var(--clay-dark); font-size: 0.95rem;">Original Artwork Sold</strong>
          <p style="margin: 0; font-size: 0.86rem; color: var(--charcoal); line-height: 1.5;">The original artwork has been sold. You can still commission a newly created version inspired by this piece.</p>
        </div>`;

  const priceDisplay = `
        <div style="margin-top: 15px; margin-bottom: 12px;">
          <div style="display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px;">
            <span style="font-size: 0.74rem; text-transform: uppercase; color: var(--muted); letter-spacing: 0.08em; font-weight: 500;">Pricing Overview</span>
            ${pricingBoxesHtml}
          </div>

          ${soldBannerHtml}

          ${purchaseOptionsBlock}
        </div>`;

  const statusClass = isSold ? 'status-sold' : (isReserved ? 'status-sold' : 'status-' + currentStatus.toLowerCase().replace(/\s+/g, '-'));
  const displayStatus = isSold ? 'Sold' : currentStatus;

  const dimsText = art.dimensions?.display || 'Available on Inquiry';
  const weightText = 'Available on Inquiry';
  const packagingText = art.shipping?.packaging || 'Museum Grade Packaging';
  const fragileText = art.shipping?.fragile || 'Yes';
  const displayCategory = art.category === 'Jewellery' ? 'Jewellery &  Handmade Creations' : art.category;

  let shippingNoticeText = '';
  if (art.category === 'Paintings') {
    shippingNoticeText = `Every painting is carefully packed using protective archival packaging to ensure safe domestic and international delivery.<br><br>Available artworks are generally dispatched within 7–10 business days after order confirmation and payment verification. Commissioned or custom paintings may require additional production time.<br><br>Domestic delivery within India is included in the INR price.<br><br>International delivery is included in the USD price for customers outside India.`;
  } else if (art.shipping?.notice) {
    shippingNoticeText = art.shipping.notice;
  } else if (art.category === 'Sculptures') {
    shippingNoticeText = `Every sculpture is carefully handcrafted and securely packaged using museum-grade protective materials for domestic and international shipping.<br><br>As most sculptures are handmade or made to order, orders are typically prepared and dispatched within 20 business days after order confirmation and payment verification.<br><br>Shipping and export charges are calculated individually for each order based on the artwork's dimensions, weight, destination country, packaging requirements, and preferred shipping method. A detailed shipping quotation will be provided during the inquiry process before order confirmation.<br><br>Shipping and export charges are calculated separately based on the artwork size, destination, and packaging requirements. Delivery times may vary depending on the destination country, customs clearance, and courier services.<br><br>Customers are responsible for applicable shipping charges, customs duties, taxes, and import regulations in their respective countries.`;
  } else if (art.category === 'Jewellery') {
    shippingNoticeText = `Jewellery and handmade creations are carefully packaged for safe domestic and international shipping.<br><br>Items that are in stock are generally dispatched within 3–7 business days after order confirmation and payment verification. Handmade or custom-made creations may require up to 20 business days before dispatch.<br><br>Shipping and export charges are calculated individually for each order based on the artwork's dimensions, weight, destination country, packaging requirements, and preferred shipping method. A detailed shipping quotation will be provided during the inquiry process before order confirmation.<br><br>Shipping charges, customs duties, taxes, and import regulations are the responsibility of the customer where applicable.`;
  } else {
    shippingNoticeText = `Every artwork is carefully packaged for domestic and international shipping. Shipping and export charges are calculated separately based on destination, artwork size, and packaging requirements. Customers are responsible for all shipping, customs duties, and import taxes applicable in their country.`;
  }

  // Featured badge html
  let featuredBadgeHtml = '';
  if (art.collection === 'Featured Sculptures') {
    featuredBadgeHtml = `
          <div style="background: rgba(180, 95, 52, 0.05); border: 1px dashed var(--clay); border-radius: var(--radius); padding: 12px 15px; margin-bottom: 5px; display: flex; align-items: center; gap: 8px;">
            <span style="display: inline-block; width: 6px; height: 6px; border-radius: 50%; background-color: var(--clay);"></span>
            <span style="font-size: 0.76rem; text-transform: uppercase; letter-spacing: 0.1em; color: var(--clay-dark); font-weight: 600;">Signature Sculpture / Featured Work</span>
          </div>`;
  }

  // Artist info html
  let artistInfoHtml = '';
  if (art.artistInfo) {
    artistInfoHtml = `
          <div style="border: 1px solid var(--line); border-radius: var(--radius); padding: 15px; background: #fafafa; margin-bottom: 5px; display: grid; gap: 8px;">
            <h4 style="font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.1em; margin: 0 0 5px; color: var(--charcoal); font-weight: 600;">Artist Profile</h4>
            <div style="font-size: 0.86rem; display: grid; gap: 6px; color: var(--muted);">
              <div style="display: flex; justify-content: space-between;"><span style="color: var(--muted);">Artist</span><strong style="color: var(--charcoal);">${art.artistInfo.artist}</strong></div>
              <div style="display: flex; justify-content: space-between;"><span style="color: var(--muted);">Institution</span><strong style="color: var(--charcoal);">${art.artistInfo.institution}</strong></div>
              <div style="display: flex; justify-content: space-between;"><span style="color: var(--muted);">Programme</span><strong style="color: var(--charcoal);">${art.artistInfo.programme}</strong></div>
              <div style="display: flex; justify-content: space-between;"><span style="color: var(--muted);">Year</span><strong style="color: var(--charcoal);">${art.artistInfo.year}</strong></div>
            </div>
          </div>`;
  }

  const descriptionText = art.description || '';

  let metaTitle = '';
  let metaDesc = '';
  let imageAlt = '';

  const escapeAttr = (str) => String(str || '').replace(/"/g, '&quot;');

  if (art.category === 'Paintings') {
    metaTitle = `${art.title} — Original ${art.medium} Painting | Shweta Studio`;
    const availText = art.availability === 'Available' ? 'Available directly from the artist studio.' : (art.availability === 'Sold' ? 'Private collection.' : 'Available on inquiry.');
    const snippet = descriptionText ? ` ${descriptionText.replace(/\s+/g, ' ').substring(0, 115).trim()}...` : '';
    metaDesc = `Original ${art.medium.toLowerCase()} painting, ${art.title} (${dimsText}), by contemporary artist ${artistName}.${snippet} ${availText}`.trim();
    imageAlt = `${art.title} — original ${art.medium.toLowerCase()} painting by ${artistName}`;
  } else if (art.category === 'Sculptures') {
    metaTitle = `${art.title} — Original ${art.medium} Sculpture | Shweta Studio`;
    const snippet = descriptionText ? ` ${descriptionText.replace(/\s+/g, ' ').substring(0, 115).trim()}...` : '';
    metaDesc = art.metaDescription ? art.metaDescription : `Original ${art.medium.toLowerCase()} sculpture, ${art.title} (${dimsText}), by artist ${artistName}.${snippet} Available upon inquiry.`.trim();
    imageAlt = (art.imageAlts && art.imageAlts[0]) ? art.imageAlts[0] : `${art.title} — original ${art.medium.toLowerCase()} sculpture by ${artistName}`;
  } else {
    metaTitle = `${art.title} — Handcrafted ${art.medium} | Shweta Studio`;
    const availText = art.availability === 'Available' ? 'Available now.' : 'Available upon inquiry.';
    const snippet = descriptionText ? ` ${descriptionText.replace(/\s+/g, ' ').substring(0, 115).trim()}...` : '';
    metaDesc = `Handcrafted ${art.medium.toLowerCase()}, ${art.title} (${dimsText}), by artist ${artistName}.${snippet} ${availText}`.trim();
    imageAlt = `${art.title} — handcrafted ${art.medium.toLowerCase()} by ${artistName}`;
  }

  const mainImgLarge = getWebpPath(art.images[0], 'large');
  const mainImgMedium = getWebpPath(art.images[0], 'medium');
  const ogImage = `https://shwetastudio.com/${encodeURI(mainImgLarge)}`;

  const isPainting = art.category === 'Paintings';
  const isSculpture = art.category === 'Sculptures';

  const artworkEntity = {
    "@type": (isPainting || isSculpture) ? "VisualArtwork" : ["VisualArtwork", "Product"],
    "name": art.title,
    "url": `https://shwetastudio.com/pieces/${art.slug}.html`,
    "image": `https://shwetastudio.com/${encodeURI(mainImgLarge)}`,
    "description": descriptionText || `${art.title} is an original ${art.medium} artwork by contemporary artist ${artistName}.`,
    "artMedium": art.medium,
    "artworkSurface": art.artworkSurface ? art.artworkSurface : (art.category === 'Paintings' ? (art.medium.toLowerCase().includes('paper') ? 'Paper' : art.medium.toLowerCase().includes('cloth') ? 'Cloth' : (art.medium.toLowerCase().includes('talapatra') || art.medium.toLowerCase().includes('palm')) ? 'Palm Leaf' : (art.medium.toLowerCase() === 'pencil colour' || art.medium.toLowerCase() === 'modern painting' ? undefined : 'Canvas')) : (art.medium && art.medium.toLowerCase().includes('cardboard') ? 'Cardboard' : 'Clay')),
    "artform": isSculpture ? "Sculpture" : (art.artworkType || (isPainting ? "Painting" : "Handcrafted Creation")),
    "width": art.dimensions?.width,
    "height": art.dimensions?.height,
    "depth": art.dimensions?.depth,
    "creator": {
      "@type": "Person",
      "name": artistName,
      "sameAs": artistName === 'Shweta Jain Maheshwari' ? "https://shwetastudio.com/story.html" : undefined
    },
    "artist": {
      "@type": "Person",
      "name": artistName,
      "sameAs": artistName === 'Shweta Jain Maheshwari' ? "https://shwetastudio.com/story.html" : undefined
    },
    "brand": {
      "@type": "Brand",
      "name": "Shweta Studio"
    }
  };

  // Only include commercial Offer for categories with direct single-currency specifications (e.g. Jewellery)
  // For Paintings (which feature dual-currency display without distinct currency URLs and pre-payment inquiry flow),
  // commercial Offer markup is omitted in accordance with Google Merchant Center guidelines until dedicated checkout URLs exist.
  if (art.category === 'Jewellery' && art.price) {
    artworkEntity.offers = {
      "@type": "Offer",
      "url": `https://shwetastudio.com/pieces/${art.slug}.html`,
      "price": art.price.replace(/[^0-9.]/g, ''),
      "priceCurrency": "USD",
      "itemCondition": "https://schema.org/NewCondition",
      "availability": art.availability === 'Available' ? "https://schema.org/InStock" : "https://schema.org/OutOfStock"
    };
  }

  const schemaObj = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "BreadcrumbList",
        "itemListElement": [
          {
            "@type": "ListItem",
            "position": 1,
            "name": "Home",
            "item": "https://shwetastudio.com/index.html"
          },
          {
            "@type": "ListItem",
            "position": 2,
            "name": "Collections",
            "item": "https://shwetastudio.com/works.html"
          },
          {
            "@type": "ListItem",
            "position": 3,
            "name": displayCategory,
            "item": `https://shwetastudio.com/${art.category.toLowerCase()}.html`
          },
          {
            "@type": "ListItem",
            "position": 4,
            "name": art.title,
            "item": `https://shwetastudio.com/pieces/${art.slug}.html`
          }
        ]
      },
      artworkEntity
    ]
  };

  let pageContent = detailTemplate
    .replaceAll('{{TITLE}}', art.title)
    .replaceAll('{{SLUG}}', art.slug)
    .replaceAll('{{CATEGORY}}', displayCategory)
    .replaceAll('{{INVENTORY_CODE}}', art.inventoryCode)
    .replaceAll('{{YEAR}}', art.year)
    .replaceAll('{{MEDIUM}}', art.medium)
    .replaceAll('{{DIMENSIONS}}', dimsText)
    .replaceAll('{{WEIGHT}}', weightText)
    .replaceAll('{{PACKAGING}}', packagingText)
    .replaceAll('{{FRAGILE}}', fragileText)
    .replaceAll('{{PRICE_DISPLAY}}', priceDisplay)
    .replaceAll('{{DESCRIPTION}}', art.description)
    .replaceAll('{{MAIN_IMAGE}}', mainImgMedium)
    .replaceAll('{{STATUS}}', displayStatus)
    .replaceAll('{{STATUS_CLASS}}', statusClass)
    .replaceAll('{{BACK_LINK}}', backLink)
    .replaceAll('{{SHIPPING_NOTICE}}', shippingNoticeText)
    .replaceAll('{{ARTIST}}', artistName)
    .replaceAll('{{BACK_TEXT}}', backText)
    .replaceAll('{{FEATURED_BADGE}}', featuredBadgeHtml)
    .replaceAll('{{ARTIST_INFO}}', artistInfoHtml)
    .replaceAll('{{THUMBNAIL_GALLERY}}', thumbHtml)
    .replaceAll('{{RELATED_WORKS}}', relatedHtml)
    .replaceAll('{{META_TITLE}}', escapeAttr(metaTitle))
    .replaceAll('{{META_DESCRIPTION}}', escapeAttr(metaDesc))
    .replaceAll('{{OG_IMAGE}}', ogImage)
    .replaceAll('{{IMAGE_ALT}}', escapeAttr(imageAlt))
    .replaceAll('{{SCHEMA_JSON}}', JSON.stringify(schemaObj, null, 2))
    .replaceAll('{{ORIGINAL_PRICE_PRIMARY}}', escapeAttr(primaryPrice))
    .replaceAll('{{PREPARATION_TIME_DISPLAY}}', escapeAttr(prepTime.displayText))
    .replaceAll('{{PREPARATION_TIME_NOTICE}}', escapeAttr(prepTime.fullNotice))
    .replaceAll('{{ORIG_WIDTH_NUM}}', String(origW))
    .replaceAll('{{ORIG_HEIGHT_NUM}}', String(origH));

  if (art.slug === 'sharabha-the-cosmic-subduer-of-narasimha') {
    const encodedMedium = encodeURI(mainImgMedium);
    const encodedFallback = encodeURI(art.images[0]);
    pageContent = pageContent.replace(
      `<img id="main-artwork-image" src="../${mainImgMedium}" alt="${escapeAttr(imageAlt)}" style="width: 100%; height: 100%; object-fit: contain; display: block;" loading="eager" fetchpriority="high">`,
      `<picture id="main-artwork-picture" style="width: 100%; height: 100%; display: flex; align-items: center; justify-content: center;">
            <source id="main-artwork-source" srcset="../${encodedMedium}" type="image/webp">
            <img id="main-artwork-image" src="../${encodedFallback}" data-fallback="../${encodedFallback}" onerror="const s=this.previousElementSibling; if(s)s.srcset=''; if(this.dataset.fallback)this.src=this.dataset.fallback;" alt="${escapeAttr(imageAlt)}" style="width: 100%; height: 100%; object-fit: contain; display: block;" loading="eager" fetchpriority="high">
          </picture>`
    );
  }

  fs.writeFileSync(path.join(OUTPUT_DIR, `${art.slug}.html`), pageContent, 'utf-8');
  sitemapLinks.push(`pieces/${art.slug}.html`);
});

// 5. In-place Template Compiling with Strict AUTO Markers
// We read base layouts from templates/ and compile them into workspace root
const pagesToCompile = [
  { file: 'story.html', type: 'base' },
  { file: 'commission.html', type: 'base' },
  { file: 'engagements.html', type: 'base' },
  { file: 'faq.html', type: 'base' },
  { file: 'contact.html', type: 'base' },
  { file: 'index.html', type: 'base' },
  { file: 'works.html', type: 'catalog' },
  { file: 'sculptures.html', type: 'catalog' },
  { file: 'paintings.html', type: 'catalog' },
  { file: 'jewellery.html', type: 'catalog' }
];

const headerStart = '<!-- AUTO_HEADER_START -->';
const headerEnd = '<!-- AUTO_HEADER_END -->';
const footerStart = '<!-- AUTO_FOOTER_START -->';
const footerEnd = '<!-- AUTO_FOOTER_END -->';
const cardsStart = '<!-- AUTO_CARDS_START -->';
const cardsEnd = '<!-- AUTO_CARDS_END -->';

pagesToCompile.forEach(page => {
  const templatePath = path.join(TEMPLATE_DIR, page.file);
  
  if (!fs.existsSync(templatePath)) {
    console.error(`[FATAL] Base template file not found: ${templatePath}`);
    process.exit(1);
  }
  
  console.log(`Compiling page template: ${page.file}...`);
  let content = fs.readFileSync(templatePath, 'utf-8');
  
  // Strict check: Verify header and footer markers exist
  if (!content.includes(headerStart) || !content.includes(headerEnd)) {
    console.error(`[FATAL] Missing header comment markers (AUTO_HEADER) in template: ${templatePath}`);
    process.exit(1);
  }
  
  if (!content.includes(footerStart) || !content.includes(footerEnd)) {
    console.error(`[FATAL] Missing footer comment markers (AUTO_FOOTER) in template: ${templatePath}`);
    process.exit(1);
  }
  
  // Replace header and footer content inside comment boundaries
  // Note: we replace everything between markers, keeping the markers themselves
  const headerRegex = /<!-- AUTO_HEADER_START -->.*?<!-- AUTO_HEADER_END -->/s;
  const footerRegex = /<!-- AUTO_FOOTER_START -->.*?<!-- AUTO_FOOTER_END -->/s;
  
  content = content.replace(headerRegex, `${headerStart}\n${headerHtml}\n${headerEnd}`);
  content = content.replace(footerRegex, `${footerStart}\n${footerHtml}\n${footerEnd}`);
  
  // Set active link inside nav based on file
  if (page.file === 'story.html') {
    content = content.replace('id="nav-story-link"', 'id="nav-story-link" class="is-active"');
  } else if (page.file === 'engagements.html') {
    content = content.replace('id="nav-engagements-link"', 'id="nav-engagements-link" class="is-active"');
  } else if (page.file === 'contact.html') {
    content = content.replace('id="nav-contact-link"', 'id="nav-contact-link" class="is-active"');
  } else if (page.file === 'index.html') {
    content = content.replace('id="nav-home-link"', 'id="nav-home-link" class="is-active"');
  } else if (['works.html', 'sculptures.html', 'paintings.html', 'jewellery.html'].includes(page.file)) {
    content = content.replace('id="nav-collections-link"', 'id="nav-collections-link" class="is-active"');
  }
  
  // Catalog pages need their dynamic card grids computed
  if (page.type === 'catalog') {
    if (!content.includes(cardsStart) || !content.includes(cardsEnd)) {
      console.error(`[FATAL] Missing cards comment markers (AUTO_CARDS) in catalog template: ${templatePath}`);
      process.exit(1);
    }
    
    let cardsHtml = '';
    
    if (page.file === 'sculptures.html') {
      cardsHtml = '<section class="collection-grid bounded-grid" style="gap: 30px;">';
      artworks.filter(a => a.category === 'Sculptures').forEach(art => {
        const primarySrc = art.cardImage || art.images[0];
        const imgMedium = getWebpPath(primarySrc, 'medium');
        const imgAlt = (art.cardImage && art.images[0] !== art.cardImage) ? getWebpPath(art.images[0], 'medium') : (art.images[1] ? getWebpPath(art.images[1], 'medium') : imgMedium);
        const imgTert = art.images[3] ? getWebpPath(art.images[3], 'medium') : (art.images[2] ? getWebpPath(art.images[2], 'medium') : imgMedium);
        
        const cardInv = inventoryStore[art.inventoryCode] || {};
        const cardStatus = cardInv.status || art.availability;
        const statusClass = 'status-' + cardStatus.toLowerCase().replace(/\s+/g, '-');
        const hasGallery = art.images.length > 1 ? 'has-gallery' : '';
        
        let imageTags = `<img class="image-primary" src="${imgMedium}" alt="${art.title} — original ${art.medium.toLowerCase()} by ${art.artist || 'Shweta Jain Maheshwari'}" style="width: 100%; height: 100%; object-fit: contain;" loading="lazy">`;
        if (art.images.length > 1) {
          imageTags += `\n              <img class="image-secondary" src="${imgAlt}" alt="${art.title} alternate view" style="width: 100%; height: 100%; object-fit: contain;" loading="lazy">`;
          imageTags += `\n              <img class="image-tertiary" src="${imgTert}" alt="${art.title} detail view" style="width: 100%; height: 100%; object-fit: contain;" loading="lazy">`;
        }
        
        let priceHtml = '';
        if (art.price) {
          const usdPrice = calculateSculptureIntlUsdPrice(art.price);
          priceHtml = `
              <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 6px; padding: 8px 10px; background: #fafafa; border: 1px solid var(--line); border-radius: var(--radius);">
                <div>
                  <span style="font-size: 0.68rem; text-transform: uppercase; color: var(--muted); letter-spacing: 0.06em; font-weight: 600; display: block;">India</span>
                  <strong style="font-size: 1.05rem; font-weight: 600; color: var(--clay); display: block; line-height: 1.2; margin: 2px 0;">${art.price}</strong>
                </div>
                <div>
                  <span style="font-size: 0.68rem; text-transform: uppercase; color: var(--muted); letter-spacing: 0.06em; font-weight: 600; display: block;">Worldwide</span>
                  <strong style="font-size: 1.05rem; font-weight: 600; color: var(--clay); display: block; line-height: 1.2; margin: 2px 0;">${usdPrice}</strong>
                </div>
              </div>`;
        } else {
          priceHtml = `
              <span style="font-size: 0.9rem; color: var(--muted); font-weight: 500;">Available on Inquiry</span>`;
        }

        const artistBadge = (art.artist && art.artist !== 'Shweta Jain Maheshwari') ? ` • By ${art.artist}` : '';

        cardsHtml += `
        <article class="collection-card ${hasGallery}" data-reveal style="background: #ffffff;">
          <a href="pieces/${art.slug}.html" style="text-decoration: none; color: inherit; display: grid;">
            <div class="image-swap" style="aspect-ratio: 4/5; border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; background: #fafafa; position: relative;">
              ${imageTags}
            </div>
            <div class="piece-copy" style="padding: 20px 0 10px;">
              <span style="font-size: 0.72rem; text-transform: uppercase; color: var(--muted); letter-spacing: 0.08em; display: block; margin-bottom: 5px;">${art.inventoryCode} • ${art.medium}${artistBadge}</span>
              <h3 style="font-family: 'Cormorant Garamond', serif; font-size: 1.62rem; font-weight: 400; margin: 0 0 8px; color: var(--charcoal);">${art.title}</h3>${priceHtml}
              <span class="status-tag ${statusClass}" style="margin-top: 8px;">${cardStatus}</span>
            </div>
          </a>
          ${renderCardActions(art, cardStatus)}
        </article>`;
      });
      cardsHtml += '\n      </section>';
    } else if (page.file === 'paintings.html') {
      cardsHtml = '<section class="collection-grid bounded-grid" style="gap: 30px;">';
      const paintingList = artworks.filter(a => a.category === 'Paintings');
      const sortedPaintings = [
        ...paintingList.filter(a => INCLUDED_DELIVERY_SKUS.has(a.inventoryCode)),
        ...paintingList.filter(a => !INCLUDED_DELIVERY_SKUS.has(a.inventoryCode))
      ];
      sortedPaintings.forEach(art => {
        const imgMedium = getWebpPath(art.images[0], 'medium');
        const cardInv = inventoryStore[art.inventoryCode] || {};
        const cardStatus = cardInv.status || art.availability;
        const statusClass = 'status-' + cardStatus.toLowerCase().replace(/\s+/g, '-');
        
        let priceHtml = '';
        if (INCLUDED_DELIVERY_SKUS.has(art.inventoryCode)) {
          const usdPrice = calculateIntlUsdPrice(art.price);
          priceHtml = `
              <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 6px; padding: 8px 10px; background: #fafafa; border: 1px solid var(--line); border-radius: var(--radius);">
                <div>
                  <span style="font-size: 0.68rem; text-transform: uppercase; color: var(--muted); letter-spacing: 0.06em; font-weight: 600; display: block;">India</span>
                  <strong style="font-size: 1.05rem; font-weight: 600; color: var(--clay); display: block; line-height: 1.2; margin: 2px 0;">${art.price}</strong>
                  <span style="font-size: 0.68rem; color: var(--sage); font-weight: 500; display: block; line-height: 1.2;">Domestic delivery included</span>
                </div>
                <div>
                  <span style="font-size: 0.68rem; text-transform: uppercase; color: var(--muted); letter-spacing: 0.06em; font-weight: 600; display: block;">Worldwide</span>
                  <strong style="font-size: 1.05rem; font-weight: 600; color: var(--clay); display: block; line-height: 1.2; margin: 2px 0;">${usdPrice}</strong>
                  <span style="font-size: 0.68rem; color: var(--sage); font-weight: 500; display: block; line-height: 1.2;">International delivery included</span>
                </div>
              </div>`;
        } else if (OLDER_PAINTING_SKUS.has(art.inventoryCode)) {
          const inrPrice = calculateDomesticInrPrice(art.price);
          priceHtml = `
              <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 6px; padding: 8px 10px; background: #fafafa; border: 1px solid var(--line); border-radius: var(--radius);">
                <div>
                  <span style="font-size: 0.68rem; text-transform: uppercase; color: var(--muted); letter-spacing: 0.06em; font-weight: 600; display: block;">India</span>
                  <strong style="font-size: 1.05rem; font-weight: 600; color: var(--clay); display: block; line-height: 1.2; margin: 2px 0;">${inrPrice}</strong>
                  <span style="font-size: 0.68rem; color: var(--sage); font-weight: 500; display: block; line-height: 1.2;">Domestic delivery included</span>
                </div>
                <div>
                  <span style="font-size: 0.68rem; text-transform: uppercase; color: var(--muted); letter-spacing: 0.06em; font-weight: 600; display: block;">Worldwide</span>
                  <strong style="font-size: 1.05rem; font-weight: 600; color: var(--clay); display: block; line-height: 1.2; margin: 2px 0;">${art.price}</strong>
                  <span style="font-size: 0.68rem; color: var(--sage); font-weight: 500; display: block; line-height: 1.2;">International delivery included</span>
                </div>
              </div>`;
        } else {
          priceHtml = `<strong style="font-size: 1.15rem; font-weight: 600; color: var(--clay);">${art.price}</strong>`;
        }

        cardsHtml += `
        <article class="collection-card" data-reveal style="background: #ffffff;">
          <a href="pieces/${art.slug}.html" style="text-decoration: none; color: inherit; display: grid;">
            <div class="image-swap" style="aspect-ratio: 4/5; border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; background: #fafafa;">
               <img class="image-primary" src="${imgMedium}" alt="${art.title} — original ${art.medium.toLowerCase()} by ${art.artist || 'Shweta Jain Maheshwari'}" loading="lazy">
            </div>
            <div class="piece-copy" style="padding: 20px 0 10px;">
              <span style="font-size: 0.72rem; text-transform: uppercase; color: var(--muted); letter-spacing: 0.08em; display: block; margin-bottom: 5px;">${art.inventoryCode} • ${art.medium}</span>
              <h3 style="font-family: 'Cormorant Garamond', serif; font-size: 1.62rem; font-weight: 400; margin: 0 0 8px; color: var(--charcoal);">${art.title}</h3>
              ${priceHtml}
              <span class="status-tag ${statusClass}" style="margin-top: 8px;">${cardStatus}</span>
            </div>
          </a>
          ${renderCardActions(art, cardStatus)}
        </article>`;
      });
      cardsHtml += '\n      </section>';
    } else if (page.file === 'jewellery.html') {
      cardsHtml = `
      <section class="bounded-grid" style="border: none; box-shadow: none; padding-top: 20px; background: #ffffff;">
        <h2 style="font-family: 'Cormorant Garamond', serif; font-size: 2.2rem; font-weight: 400; margin-bottom: 25px; border-bottom: 1px solid var(--line); padding-bottom: 10px; color: var(--charcoal);">$10 Collection</h2>
        <div class="collection-grid" style="gap: 30px;">`;
        
      artworks.filter(a => a.category === 'Jewellery' && a.collection === '$10 Collection').forEach(art => {
        const inrPrice = calculateJewelleryInrPrice(art.price);
        const imgMedium = getWebpPath(art.images[0], 'medium');
        const imgAlt = art.images[1] ? getWebpPath(art.images[1], 'medium') : imgMedium;
        const imgTert = art.images[2] ? getWebpPath(art.images[2], 'medium') : imgMedium;
        const cardInv = inventoryStore[art.inventoryCode] || {};
        const cardStatus = cardInv.status || art.availability;
        const statusClass = 'status-' + cardStatus.toLowerCase().replace(/\s+/g, '-');
        const hasGallery = art.images.length > 1 ? 'has-gallery' : '';
        const galleryClass = art.images.length === 2 ? 'has-gallery has-2-images' : hasGallery;
        
        let imageTags = `<img class="image-primary" src="${imgMedium}" alt="${art.title} by ${art.artist || 'Shweta Jain'}" loading="lazy">`;
        if (art.images.length > 1) {
          imageTags += `\n                <img class="image-secondary" src="${imgAlt}" alt="${art.title} alternate view" loading="lazy">`;
          if (art.images.length > 2) {
            imageTags += `\n                <img class="image-tertiary" src="${imgTert}" alt="${art.title} detail view" loading="lazy">`;
          }
        }
        
        cardsHtml += `
          <article class="collection-card ${galleryClass}" data-reveal style="background: #ffffff;">
            <a href="pieces/${art.slug}.html" style="text-decoration: none; color: inherit; display: grid;">
              <div class="image-swap" style="aspect-ratio: 4/5; border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; background: #fafafa;">
                ${imageTags}
              </div>
              <div class="piece-copy" style="padding: 20px 0 10px;">
                <span style="font-size: 0.72rem; text-transform: uppercase; color: var(--muted); letter-spacing: 0.08em; display: block; margin-bottom: 5px;">${art.inventoryCode} • ${art.medium}</span>
                <h3 style="font-family: 'Cormorant Garamond', serif; font-size: 1.62rem; font-weight: 400; margin: 0 0 8px; color: var(--charcoal);">${art.title}</h3>
                <div style="margin: 4px 0 6px;">
                  <strong style="font-size: 1.15rem; font-weight: 600; color: var(--clay); display: block; line-height: 1.2;">${inrPrice}</strong>
                  <span style="font-size: 0.9rem; font-weight: 500; color: var(--muted); display: block; margin-top: 2px;">${art.price}</span>
                </div>
                <span class="status-tag ${statusClass}" style="margin-top: 8px;">${cardStatus}</span>
              </div>
            </a>
            ${renderCardActions(art, cardStatus)}
          </article>`;
      });
      
      cardsHtml += `
        </div>
      </section>
      <section class="bounded-grid" style="border: none; box-shadow: none; padding-top: 40px; background: #ffffff;">
        <h2 style="font-family: 'Cormorant Garamond', serif; font-size: 2.2rem; font-weight: 400; margin-bottom: 25px; border-bottom: 1px solid var(--line); padding-bottom: 10px; color: var(--charcoal);">$20 Collection</h2>
        <div class="collection-grid" style="gap: 30px;">`;
        
      artworks.filter(a => a.category === 'Jewellery' && a.collection === '$20 Collection').forEach(art => {
        const inrPrice = calculateJewelleryInrPrice(art.price);
        const imgMedium = getWebpPath(art.images[0], 'medium');
        const imgAlt = art.images[1] ? getWebpPath(art.images[1], 'medium') : imgMedium;
        const imgTert = art.images[2] ? getWebpPath(art.images[2], 'medium') : imgMedium;
        const cardInv = inventoryStore[art.inventoryCode] || {};
        const cardStatus = cardInv.status || art.availability;
        const statusClass = 'status-' + cardStatus.toLowerCase().replace(/\s+/g, '-');
        const hasGallery = art.images.length > 1 ? 'has-gallery' : '';
        const galleryClass = art.images.length === 2 ? 'has-gallery has-2-images' : hasGallery;
        
        let imageTags = `<img class="image-primary" src="${imgMedium}" alt="${art.title} by ${art.artist || 'Shweta Jain'}" loading="lazy">`;
        if (art.images.length > 1) {
          imageTags += `\n                <img class="image-secondary" src="${imgAlt}" alt="${art.title} alternate view" loading="lazy">`;
          if (art.images.length > 2) {
            imageTags += `\n                <img class="image-tertiary" src="${imgTert}" alt="${art.title} detail view" loading="lazy">`;
          }
        }
        
        cardsHtml += `
          <article class="collection-card ${galleryClass}" data-reveal style="background: #ffffff;">
            <a href="pieces/${art.slug}.html" style="text-decoration: none; color: inherit; display: grid;">
              <div class="image-swap" style="aspect-ratio: 4/5; border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; background: #fafafa;">
                ${imageTags}
              </div>
              <div class="piece-copy" style="padding: 20px 0 10px;">
                <span style="font-size: 0.72rem; text-transform: uppercase; color: var(--muted); letter-spacing: 0.08em; display: block; margin-bottom: 5px;">${art.inventoryCode} • ${art.medium}</span>
                <h3 style="font-family: 'Cormorant Garamond', serif; font-size: 1.62rem; font-weight: 400; margin: 0 0 8px; color: var(--charcoal);">${art.title}</h3>
                <div style="margin: 4px 0 6px;">
                  <strong style="font-size: 1.15rem; font-weight: 600; color: var(--clay); display: block; line-height: 1.2;">${inrPrice}</strong>
                  <span style="font-size: 0.9rem; font-weight: 500; color: var(--muted); display: block; margin-top: 2px;">${art.price}</span>
                </div>
                <span class="status-tag ${statusClass}" style="margin-top: 8px;">${cardStatus}</span>
              </div>
            </a>
            ${renderCardActions(art, cardStatus)}
          </article>`;
      });
      cardsHtml += '\n        </div>\n      </section>';
    } else if (page.file === 'works.html') {
      const sculpCover = getWebpPath(artworks.find(a => a.id === 1).images[0], 'medium');
      const paintCover = getWebpPath(artworks.find(a => a.id === 11).images[0], 'medium');
      const jewelCover = getWebpPath(artworks.find(a => a.id === 26).images[0], 'medium');
      
      const sculpCount = artworks.filter(a => a.category === 'Sculptures').length;
      const paintCount = artworks.filter(a => a.category === 'Paintings').length;
      const jewelCount = artworks.filter(a => a.category === 'Jewellery').length;
      
      cardsHtml = `
      <section class="collection-grid bounded-grid works-category-grid" style="background: #ffffff; border: none; box-shadow: none; gap: 30px;">
        <article class="collection-card" data-reveal style="background: #ffffff;">
          <div class="image-swap" style="aspect-ratio: 4/5; border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; background: #fafafa;">
            <img src="${sculpCover}" alt="Sculptures Collection by Shweta Jain Maheshwari" style="width: 100%; height: 100%; object-fit: contain;">
          </div>
          <div class="piece-copy" style="padding: 20px 0 15px; display: grid; gap: 6px;">
            <h3 style="font-family: 'Cormorant Garamond', serif; font-size: 1.8rem; font-weight: 400; margin: 0; color: var(--charcoal);">Sculptures</h3>
            <span style="color: var(--muted); font-size: 0.86rem;">${sculpCount} Works</span>
            <a href="sculptures.html" class="button button-secondary" style="margin-top: 10px; width: fit-content; border-radius: 4px; font-size: 0.76rem; padding: 6px 16px;">View Collection</a>
          </div>
        </article>
 
        <article class="collection-card" data-reveal style="background: #ffffff;">
          <div class="image-swap" style="aspect-ratio: 4/5; border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; background: #fafafa;">
            <img src="${paintCover}" alt="Paintings Collection by Shweta Jain Maheshwari" style="width: 100%; height: 100%; object-fit: contain;">
          </div>
          <div class="piece-copy" style="padding: 20px 0 15px; display: grid; gap: 6px;">
            <h3 style="font-family: 'Cormorant Garamond', serif; font-size: 1.8rem; font-weight: 400; margin: 0; color: var(--charcoal);">Paintings</h3>
            <span style="color: var(--muted); font-size: 0.86rem;">${paintCount} Works</span>
            <a href="paintings.html" class="button button-secondary" style="margin-top: 10px; width: fit-content; border-radius: 4px; font-size: 0.76rem; padding: 6px 16px;">View Collection</a>
          </div>
        </article>
 
        <article class="collection-card" data-reveal style="background: #ffffff;">
          <div class="image-swap" style="aspect-ratio: 4/5; border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; background: #fafafa;">
            <img src="${jewelCover}" alt="Jewellery &  Handmade Creations Collection" style="width: 100%; height: 100%; object-fit: contain;">
          </div>
          <div class="piece-copy" style="padding: 20px 0 15px; display: grid; gap: 6px;">
            <h3 style="font-family: 'Cormorant Garamond', serif; font-size: 1.8rem; font-weight: 400; margin: 0; color: var(--charcoal);">Jewellery &  Handmade Creations</h3>
            <span style="color: var(--muted); font-size: 0.86rem;">${jewelCount} Works</span>
            <a href="jewellery.html" class="button button-secondary" style="margin-top: 10px; width: fit-content; border-radius: 4px; font-size: 0.76rem; padding: 6px 16px;">View Collection</a>
          </div>
        </article>
      </section>`;
    }
    
    const cardsRegex = /<!-- AUTO_CARDS_START -->.*?<!-- AUTO_CARDS_END -->/s;
    content = content.replace(cardsRegex, `${cardsStart}\n${cardsHtml}\n${cardsEnd}`);
  }
  
  // Ensure ecommerce.css is linked in page <head>
  if (!content.includes('styles/ecommerce.css')) {
    content = content.replace('</head>', '  <link rel="stylesheet" href="styles/ecommerce.css">\n</head>');
  }

  // Write output page to root
  fs.writeFileSync(page.file, content, 'utf-8');
});

// 6. Generate sitemap.xml
console.log('Generating sitemap.xml...');
const rootPages = [
  'index.html',
  'works.html',
  'sculptures.html',
  'paintings.html',
  'jewellery.html',
  'story.html',
  'engagements.html',
  'contact.html',
  'commission.html',
  'faq.html',
  'cart.html',
  'checkout.html',
  'order-confirmation.html'
];

let sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
`;

const todayStr = new Date().toISOString().split('T')[0];

rootPages.forEach(p => {
  sitemapXml += `  <url>
    <loc>https://shwetastudio.com/${p}</loc>
    <lastmod>${todayStr}</lastmod>
    <changefreq>${p === 'index.html' ? 'daily' : (p.includes('html') ? 'weekly' : 'monthly')}</changefreq>
    <priority>${p === 'index.html' ? '1.0' : (p === 'paintings.html' || p === 'works.html' ? '0.9' : '0.8')}</priority>
  </url>\n`;
});

sitemapLinks.forEach(p => {
  sitemapXml += `  <url>
    <loc>https://shwetastudio.com/${p}</loc>
    <lastmod>${todayStr}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>
  </url>\n`;
});

sitemapXml += `</urlset>`;
fs.writeFileSync('./sitemap.xml', sitemapXml, 'utf-8');
console.log('sitemap.xml generated successfully.');

// 7. Generate robots.txt
console.log('Generating robots.txt...');
const robotsTxt = `User-agent: *
Allow: /

Sitemap: https://shwetastudio.com/sitemap.xml
`;
fs.writeFileSync('./robots.txt', robotsTxt, 'utf-8');
console.log('robots.txt generated successfully.');

// 8. Post-compilation validation scan
// Scan all generated HTML files for unresolved template tags like ${headerHtml} or {{TITLE}}
console.log('Scanning all generated HTML files for unresolved variables...');

const directoriesToScan = ['.', './pieces'];
let unresolvedErrors = 0;

directoriesToScan.forEach(dir => {
  const files = fs.readdirSync(dir);
  files.forEach(file => {
    if (file.endsWith('.html')) {
      const filePath = path.join(dir, file);
      // Skip the template file itself
      if (file === 'detail_template.html') return;
      
      const fileContent = fs.readFileSync(filePath, 'utf-8');
      
      // Look for unresolved ${variable} patterns
      // Ignore valid JS code strings inside script tags by checking common variables
      const templateLiteralPattern = /\$\{(headerHtml|footerHtml|cardsHtml|seoTags|featuredSculpture|featImgMedium)\}/g;
      const matchesLiteral = fileContent.match(templateLiteralPattern);
      if (matchesLiteral) {
        matchesLiteral.forEach(match => {
          console.error(`[ERROR] Unresolved template literal variable '${match}' found in: ${filePath}`);
          unresolvedErrors++;
        });
      }
      
      // Look for unresolved {{VARIABLE}} patterns
      const mustachePattern = /\{\{[A-Z_]+\}\}/g;
      const matchesMustache = fileContent.match(mustachePattern);
      if (matchesMustache) {
        matchesMustache.forEach(match => {
          console.error(`[ERROR] Unresolved mustache template tag '${match}' found in: ${filePath}`);
          unresolvedErrors++;
        });
      }
    }
  });
});

if (unresolvedErrors > 0) {
  console.error(`[FATAL] Build failed: Found ${unresolvedErrors} unresolved template variables!`);
  process.exit(1);
} else {
  console.log('[SUCCESS] Post-compilation validation check passed. Zero unresolved variables found.');
}

console.log('Compilation complete!');
