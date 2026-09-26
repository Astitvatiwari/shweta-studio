// compile.js - Node.js Static Site Generator compiler for Shweta Studio
import fs from 'fs';
import path from 'path';
import artworks from './artworks.js';

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
  '{{FEATURED_BADGE}}', '{{ARTIST_INFO}}', '{{OG_IMAGE}}', '{{IMAGE_ALT}}'
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
      priceInfo = `<strong style="font-size: 0.95rem; color: var(--muted); font-weight: 500;">Available on Inquiry</strong>`;
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
      thumbHtml += `
            <div class="gallery-thumb-item" style="border-radius: 4px; overflow: hidden; aspect-ratio: 1; cursor: pointer; ${borderStyle} transition: border-color 0.24s;" onclick="swapImage(this, '../${imgMedium}')">
              <img src="../${imgThumb}" alt="${art.title} — view ${idx+1} by ${artistName}" style="width: 100%; height: 100%; object-fit: cover;" loading="lazy">
            </div>`;
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

  let priceDisplay = '';
  if (art.category === 'Sculptures') {
    priceDisplay = `<div style="display: flex; flex-direction: column; gap: 4px; margin-top: 15px; margin-bottom: 10px;">
            <span style="font-size: 0.74rem; text-transform: uppercase; color: var(--muted); letter-spacing: 0.08em; font-weight: 500;">Pricing</span>
            <strong style="font-size: 1.8rem; color: var(--clay); font-weight: 500;">Price available upon request</strong>
          </div>`;
  } else if (art.category === 'Paintings') {
    let pricingBoxesHtml = '';
    if (INCLUDED_DELIVERY_SKUS.has(art.inventoryCode)) {
      const usdPrice = calculateIntlUsdPrice(art.price);
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
      pricingBoxesHtml = `<strong style="font-size: 1.8rem; color: var(--clay); font-weight: 500;">${art.price}</strong>`;
    }

    const origW = parseDimensionValue(art.dimensions?.width);
    const origH = parseDimensionValue(art.dimensions?.height);
    const origDimsDisplay = (origW && origH) ? `${origW} × ${origH} inches` : (art.dimensions?.display || 'Original Proportions');

    priceDisplay = `
          <div style="margin-top: 15px; margin-bottom: 12px;">
            <!-- Selection Option: Original Artwork vs Customize Size -->
            <div style="display: flex; gap: 8px; margin-bottom: 12px; border-bottom: 1px solid var(--line); padding-bottom: 10px;" role="tablist">
              <button type="button" id="tab-original-size" onclick="selectPaintingSizeMode('original')" role="tab" aria-selected="true" style="padding: 8px 16px; border-radius: var(--radius); font-size: 0.84rem; font-weight: 600; cursor: pointer; transition: all 0.2s ease; border: 1px solid var(--clay); background: var(--clay); color: #ffffff;">
                Original Artwork
              </button>
              <button type="button" id="tab-custom-size" onclick="selectPaintingSizeMode('custom')" role="tab" aria-selected="false" style="padding: 8px 16px; border-radius: var(--radius); font-size: 0.84rem; font-weight: 600; cursor: pointer; transition: all 0.2s ease; border: 1px solid var(--line); background: #ffffff; color: var(--charcoal);">
                Customize Size
              </button>
            </div>

            <!-- View 1: Original Artwork (Default) -->
            <div id="view-original-size" role="tabpanel" style="display: block;">
              <div style="display: flex; flex-direction: column; gap: 8px; margin-bottom: 10px;">
                <span style="font-size: 0.74rem; text-transform: uppercase; color: var(--muted); letter-spacing: 0.08em; font-weight: 500;">Pricing</span>
                ${pricingBoxesHtml}
              </div>
              <div style="display: flex; flex-direction: column; gap: 6px; padding: 12px 14px; background: #fafafa; border: 1px solid var(--line); border-radius: var(--radius); margin-top: 10px;">
                <div style="display: flex; align-items: center; gap: 8px;">
                  <span style="display: inline-block; width: 8px; height: 8px; border-radius: 50%; background-color: var(--sage);"></span>
                  <strong style="font-size: 0.86rem; color: var(--charcoal); font-weight: 600;">Original artwork &bull; 1 available</strong>
                </div>
                <div style="font-size: 0.8rem; color: var(--muted); line-height: 1.4;">
                  Dispatch within 15 days of order confirmation and payment verification.
                </div>
              </div>
            </div>

            <!-- View 2: Customize Size -->
            <div id="view-custom-size" data-orig-width="${origW}" data-orig-height="${origH}" role="tabpanel" style="display: none; padding: 16px; background: #fafafa; border: 1px solid var(--line); border-radius: var(--radius);">
              <div style="margin-bottom: 12px;">
                <h4 style="font-family: 'Cormorant Garamond', serif; font-size: 1.35rem; font-weight: 600; margin: 0 0 4px; color: var(--charcoal);">Custom Size</h4>
                <p style="font-size: 0.82rem; color: var(--muted); margin: 0; line-height: 1.4;">Maintain original artwork proportions (${origDimsDisplay})</p>
              </div>

              <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 12px;">
                <div>
                  <label for="custom-width" style="display: block; font-size: 0.76rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); font-weight: 600; margin-bottom: 6px;">Width (inches)</label>
                  <input type="number" id="custom-width" value="${origW}" step="any" min="1" oninput="onCustomWidthChange(this.value)" style="width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid var(--line); border-radius: 4px; font-family: inherit; font-size: 0.9rem; background: #ffffff;">
                </div>
                <div>
                  <label for="custom-height" style="display: block; font-size: 0.76rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); font-weight: 600; margin-bottom: 6px;">Height (inches)</label>
                  <input type="number" id="custom-height" value="${origH}" step="any" min="1" oninput="onCustomHeightChange(this.value)" style="width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid var(--line); border-radius: 4px; font-family: inherit; font-size: 0.9rem; background: #ffffff;">
                </div>
              </div>

              <div id="aspect-ratio-feedback" style="font-size: 0.8rem; margin-bottom: 14px; min-height: 20px;">
                <span style="color: var(--sage); display: flex; align-items: center; gap: 4px;">✓ Proportions match original artwork (${origDimsDisplay})</span>
              </div>

              <div style="display: flex; align-items: center; gap: 8px; padding: 10px 12px; background: #ffffff; border: 1px solid var(--line); border-radius: 4px; margin-bottom: 16px;">
                <span style="color: var(--clay); font-size: 0.95rem;">⏱</span>
                <span style="font-size: 0.82rem; color: var(--charcoal); font-weight: 500;">Production time: Up to 2 months for production</span>
              </div>

              <button type="button" id="btn-request-custom-size" onclick="submitCustomSizeRequest()" style="width: 100%; padding: 12px 18px; background: var(--clay); color: #ffffff; border: none; border-radius: 4px; font-family: inherit; font-size: 0.86rem; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; cursor: pointer; transition: background 0.2s ease;">
                Request Custom Size
              </button>
            </div>
          </div>`;
  } else {
    priceDisplay = `<div style="display: flex; flex-direction: column; gap: 4px; margin-top: 15px; margin-bottom: 10px;">
            <span style="font-size: 0.74rem; text-transform: uppercase; color: var(--muted); letter-spacing: 0.08em; font-weight: 500;">Pricing</span>
            <strong style="font-size: 1.8rem; color: var(--clay); font-weight: 500;">${art.price}</strong>
          </div>`;
  }
  const statusClass = 'status-' + art.availability.toLowerCase().replace(/\s+/g, '-');

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
    metaDesc = `Original ${art.medium.toLowerCase()} sculpture, ${art.title} (${dimsText}), by artist ${artistName}.${snippet} Available upon inquiry.`.trim();
    imageAlt = `${art.title} — original ${art.medium.toLowerCase()} sculpture by ${artistName}`;
  } else {
    metaTitle = `${art.title} — Handcrafted ${art.medium} | Shweta Studio`;
    const availText = art.availability === 'Available' ? 'Available now.' : 'Available upon inquiry.';
    const snippet = descriptionText ? ` ${descriptionText.replace(/\s+/g, ' ').substring(0, 115).trim()}...` : '';
    metaDesc = `Handcrafted ${art.medium.toLowerCase()}, ${art.title} (${dimsText}), by artist ${artistName}.${snippet} ${availText}`.trim();
    imageAlt = `${art.title} — handcrafted ${art.medium.toLowerCase()} by ${artistName}`;
  }

  const mainImgLarge = getWebpPath(art.images[0], 'large');
  const mainImgMedium = getWebpPath(art.images[0], 'medium');
  const ogImage = `https://swetastudio.com/${encodeURI(mainImgLarge)}`;

  const isPainting = art.category === 'Paintings';
  const isSculpture = art.category === 'Sculptures';

  const artworkEntity = {
    "@type": (isPainting || isSculpture) ? "VisualArtwork" : ["VisualArtwork", "Product"],
    "name": art.title,
    "url": `https://swetastudio.com/pieces/${art.slug}.html`,
    "image": `https://swetastudio.com/${encodeURI(mainImgLarge)}`,
    "description": descriptionText || `${art.title} is an original ${art.medium} artwork by contemporary artist ${artistName}.`,
    "artMedium": art.medium,
    "artworkSurface": art.artworkSurface ? art.artworkSurface : (art.category === 'Paintings' ? (art.medium.toLowerCase().includes('paper') ? 'Paper' : art.medium.toLowerCase().includes('cloth') ? 'Cloth' : (art.medium.toLowerCase().includes('talapatra') || art.medium.toLowerCase().includes('palm')) ? 'Palm Leaf' : (art.medium.toLowerCase() === 'pencil colour' || art.medium.toLowerCase() === 'modern painting' ? undefined : 'Canvas')) : 'Clay'),
    "artform": isSculpture ? "Sculpture" : (art.artworkType || (isPainting ? "Painting" : "Handcrafted Creation")),
    "width": art.dimensions?.width,
    "height": art.dimensions?.height,
    "depth": art.dimensions?.depth,
    "creator": {
      "@type": "Person",
      "name": artistName,
      "sameAs": artistName === 'Shweta Jain Maheshwari' ? "https://swetastudio.com/story.html" : undefined
    },
    "artist": {
      "@type": "Person",
      "name": artistName,
      "sameAs": artistName === 'Shweta Jain Maheshwari' ? "https://swetastudio.com/story.html" : undefined
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
      "url": `https://swetastudio.com/pieces/${art.slug}.html`,
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
            "item": "https://swetastudio.com/index.html"
          },
          {
            "@type": "ListItem",
            "position": 2,
            "name": "Collections",
            "item": "https://swetastudio.com/works.html"
          },
          {
            "@type": "ListItem",
            "position": 3,
            "name": displayCategory,
            "item": `https://swetastudio.com/${art.category.toLowerCase()}.html`
          },
          {
            "@type": "ListItem",
            "position": 4,
            "name": art.title,
            "item": `https://swetastudio.com/pieces/${art.slug}.html`
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
    .replaceAll('{{STATUS}}', art.availability)
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
    .replaceAll('{{SCHEMA_JSON}}', JSON.stringify(schemaObj, null, 2));

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
        const imgMedium = getWebpPath(art.images[0], 'medium');
        const imgAlt = art.images[1] ? getWebpPath(art.images[1], 'medium') : imgMedium;
        const imgTert = art.images[2] ? getWebpPath(art.images[2], 'medium') : imgMedium;
        const statusClass = 'status-' + art.availability.toLowerCase().replace(/\s+/g, '-');
        const hasGallery = art.images.length > 1 ? 'has-gallery' : '';
        
        let imageTags = `<img class="image-primary" src="${imgMedium}" alt="${art.title} — original ${art.medium.toLowerCase()} by ${art.artist || 'Shweta Jain Maheshwari'}" loading="lazy">`;
        if (art.images.length > 1) {
          imageTags += `\n              <img class="image-secondary" src="${imgAlt}" alt="${art.title} alternate view" loading="lazy">`;
          imageTags += `\n              <img class="image-tertiary" src="${imgTert}" alt="${art.title} detail view" loading="lazy">`;
        }
        
        cardsHtml += `
        <article class="collection-card ${hasGallery}" data-reveal style="background: #ffffff;">
          <a href="pieces/${art.slug}.html" style="text-decoration: none; color: inherit; display: grid;">
            <div class="image-swap" style="aspect-ratio: 4/5; border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; background: #fafafa;">
              ${imageTags}
            </div>
            <div class="piece-copy" style="padding: 20px 0 15px;">
              <span style="font-size: 0.72rem; text-transform: uppercase; color: var(--muted); letter-spacing: 0.08em; display: block; margin-bottom: 5px;">${art.inventoryCode} • ${art.medium}</span>
              <h3 style="font-family: 'Cormorant Garamond', serif; font-size: 1.62rem; font-weight: 400; margin: 0 0 8px; color: var(--charcoal);">${art.title}</h3>
              <span style="font-size: 0.9rem; color: var(--muted); font-weight: 500;">Available on Inquiry</span>
              <span class="status-tag ${statusClass}" style="margin-top: 8px;">${art.availability}</span>
              <span class="button button-secondary" style="margin-top: 15px; width: fit-content; font-size: 0.76rem; padding: 6px 16px; border-radius: 4px;">View Details</span>
            </div>
          </a>
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
        const statusClass = 'status-' + art.availability.toLowerCase().replace(/\s+/g, '-');
        
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
            <div class="piece-copy" style="padding: 20px 0 15px;">
              <span style="font-size: 0.72rem; text-transform: uppercase; color: var(--muted); letter-spacing: 0.08em; display: block; margin-bottom: 5px;">${art.inventoryCode} • ${art.medium}</span>
              <h3 style="font-family: 'Cormorant Garamond', serif; font-size: 1.62rem; font-weight: 400; margin: 0 0 8px; color: var(--charcoal);">${art.title}</h3>
              ${priceHtml}
              <span class="status-tag ${statusClass}" style="margin-top: 8px;">${art.availability}</span>
              <span class="button button-secondary" style="margin-top: 15px; width: fit-content; font-size: 0.76rem; padding: 6px 16px; border-radius: 4px;">Request Availability</span>
            </div>
          </a>
        </article>`;
      });
      cardsHtml += '\n      </section>';
    } else if (page.file === 'jewellery.html') {
      cardsHtml = `
      <section class="bounded-grid" style="border: none; box-shadow: none; padding-top: 20px; background: #ffffff;">
        <h2 style="font-family: 'Cormorant Garamond', serif; font-size: 2.2rem; font-weight: 400; margin-bottom: 25px; border-bottom: 1px solid var(--line); padding-bottom: 10px; color: var(--charcoal);">$10 Collection</h2>
        <div class="collection-grid" style="gap: 30px;">`;
        
      artworks.filter(a => a.category === 'Jewellery' && a.collection === '$10 Collection').forEach(art => {
        const imgMedium = getWebpPath(art.images[0], 'medium');
        const imgAlt = art.images[1] ? getWebpPath(art.images[1], 'medium') : imgMedium;
        const imgTert = art.images[2] ? getWebpPath(art.images[2], 'medium') : imgMedium;
        const statusClass = 'status-' + art.availability.toLowerCase().replace(/\s+/g, '-');
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
              <div class="piece-copy" style="padding: 20px 0 15px;">
                <span style="font-size: 0.72rem; text-transform: uppercase; color: var(--muted); letter-spacing: 0.08em; display: block; margin-bottom: 5px;">${art.inventoryCode} • ${art.medium}</span>
                <h3 style="font-family: 'Cormorant Garamond', serif; font-size: 1.62rem; font-weight: 400; margin: 0 0 8px; color: var(--charcoal);">${art.title}</h3>
                <strong style="font-size: 1.15rem; font-weight: 600; color: var(--clay);">${art.price}</strong>
                <span class="status-tag ${statusClass}" style="margin-top: 8px;">${art.availability}</span>
                <span class="button button-secondary" style="margin-top: 15px; width: fit-content; font-size: 0.76rem; padding: 6px 16px; border-radius: 4px;">Inquire about this artwork</span>
              </div>
            </a>
          </article>`;
      });
      
      cardsHtml += `
        </div>
      </section>
      <section class="bounded-grid" style="border: none; box-shadow: none; padding-top: 40px; background: #ffffff;">
        <h2 style="font-family: 'Cormorant Garamond', serif; font-size: 2.2rem; font-weight: 400; margin-bottom: 25px; border-bottom: 1px solid var(--line); padding-bottom: 10px; color: var(--charcoal);">$20 Collection</h2>
        <div class="collection-grid" style="gap: 30px;">`;
        
      artworks.filter(a => a.category === 'Jewellery' && a.collection === '$20 Collection').forEach(art => {
        const imgMedium = getWebpPath(art.images[0], 'medium');
        const imgAlt = art.images[1] ? getWebpPath(art.images[1], 'medium') : imgMedium;
        const imgTert = art.images[2] ? getWebpPath(art.images[2], 'medium') : imgMedium;
        const statusClass = 'status-' + art.availability.toLowerCase().replace(/\s+/g, '-');
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
              <div class="piece-copy" style="padding: 20px 0 15px;">
                <span style="font-size: 0.72rem; text-transform: uppercase; color: var(--muted); letter-spacing: 0.08em; display: block; margin-bottom: 5px;">${art.inventoryCode} • ${art.medium}</span>
                <h3 style="font-family: 'Cormorant Garamond', serif; font-size: 1.62rem; font-weight: 400; margin: 0 0 8px; color: var(--charcoal);">${art.title}</h3>
                <strong style="font-size: 1.15rem; font-weight: 600; color: var(--clay);">${art.price}</strong>
                <span class="status-tag ${statusClass}" style="margin-top: 8px;">${art.availability}</span>
                <span class="button button-secondary" style="margin-top: 15px; width: fit-content; font-size: 0.76rem; padding: 6px 16px; border-radius: 4px;">Inquire about this artwork</span>
              </div>
            </a>
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
  'faq.html'
];

let sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
`;

const todayStr = '2026-09-26';

rootPages.forEach(p => {
  sitemapXml += `  <url>
    <loc>https://swetastudio.com/${p}</loc>
    <lastmod>${todayStr}</lastmod>
    <changefreq>${p === 'index.html' ? 'daily' : (p.includes('html') ? 'weekly' : 'monthly')}</changefreq>
    <priority>${p === 'index.html' ? '1.0' : (p === 'paintings.html' || p === 'works.html' ? '0.9' : '0.8')}</priority>
  </url>\n`;
});

sitemapLinks.forEach(p => {
  sitemapXml += `  <url>
    <loc>https://swetastudio.com/${p}</loc>
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

Sitemap: https://swetastudio.com/sitemap.xml
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
