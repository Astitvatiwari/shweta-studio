/*
==========================================
FILE: forms.js
PURPOSE: Form inquiry handlers, EmailJS integrations, validation, and email client mailto redirects.
Author: Shweta Studio
==========================================
*/

import { captureLeadDetails, openMailto } from './utils.js';

/* ==========================================
   EMAILJS CONFIGURATION KEYS
========================================== */
const EMAILJS_SERVICE_ID = "YOUR_SERVICE_ID"; 
const EMAILJS_TEMPLATE_ID = "YOUR_TEMPLATE_ID";
const EMAILJS_PUBLIC_KEY = "YOUR_PUBLIC_KEY";

/* ==========================================
   ARTWORK INQUIRY HANDLER (DETAIL PAGE)
========================================== */
export function sendInquiry(event) {
  event.preventDefault();
  
  const form = event.target;
  const name = form.name.value;
  const email = form.email.value;
  const country = form.country.value;
  const phone = form.phone.value || "Not provided";
  const purpose = form.purpose.value;
  const message = form.message.value;
  
  const artworkTitle = window.artworkConfig?.title || "Unknown Artwork";
  const category = window.artworkConfig?.category || "General";
  const inventoryCode = window.artworkConfig?.inventoryCode || "N/A";
  
  const lead = captureLeadDetails();
  
  const emailBody = `Hello,

I am interested in the artwork:

Artwork: ${artworkTitle} (${inventoryCode})
Category: ${category}
Purpose: ${purpose}

Customer Details:
Name: ${name}
Email: ${email}
Country: ${country}
Phone: ${phone}

Inquiry Message:
${message}

---
Lead Details:
Date: ${lead.date}
Browser: ${lead.browser}
Source URL: ${lead.sourceUrl}
`;

  if (typeof emailjs !== 'undefined' && EMAILJS_SERVICE_ID !== "YOUR_SERVICE_ID" && EMAILJS_PUBLIC_KEY !== "YOUR_PUBLIC_KEY") {
    const statusText = document.getElementById("form-status");
    if (statusText) {
      statusText.innerText = "Sending inquiry...";
      statusText.style.color = "var(--muted)";
    }
    
    emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, {
      from_name: name,
      from_email: email,
      phone: phone,
      country: country,
      purpose: purpose,
      artwork_name: artworkTitle,
      artwork_code: inventoryCode,
      category: category,
      message: message,
      lead_date: lead.date,
      lead_browser: lead.browser,
      lead_source: lead.sourceUrl
    }).then(function() {
      if (statusText) {
        statusText.innerText = "Thank you! Your inquiry has been sent successfully.";
        statusText.style.color = "var(--sage)";
      }
      form.reset();
    }, function(error) {
      console.error("EmailJS failed:", error);
      if (statusText) {
        statusText.innerText = "Failed to send via form service. Opening email client instead...";
        statusText.style.color = "var(--clay)";
      }
      openMailto("hello.shwetastudio@gmail.com", `Inquiry about ${artworkTitle} [${inventoryCode}]`, emailBody, "form-status");
    });
  } else {
    openMailto("hello.shwetastudio@gmail.com", `Inquiry about ${artworkTitle} [${inventoryCode}]`, emailBody, "form-status");
  }
}

/* ==========================================
   DIRECT INQUIRY SHORTCUT (DETAIL PAGE)
========================================== */
export function triggerDirectInquiry() {
  const form = document.getElementById('inquiry-form');
  if (!form) return;
  
  const message = form.message.value || "Please share availability and shipping details.";
  const country = form.country.value || "Not specified";
  const name = form.name.value || "Collector";
  
  const artworkTitle = window.artworkConfig?.title || "Unknown Artwork";
  const category = window.artworkConfig?.category || "General";
  const inventoryCode = window.artworkConfig?.inventoryCode || "N/A";
  
  const lead = captureLeadDetails();
  
  const emailBody = `Hello,

I am interested in the artwork:

Artwork: ${artworkTitle} (${inventoryCode})
Category: ${category}

Customer Details:
Name: ${name}
Country: ${country}

Inquiry Message:
${message}

---
Lead Details:
Date: ${lead.date}
Browser: ${lead.browser}
Source URL: ${lead.sourceUrl}
`;
  
  openMailto("hello.shwetastudio@gmail.com", `Inquiry about ${artworkTitle} [${inventoryCode}]`, emailBody, "form-status");
}

/* ==========================================
   CONTACT INQUIRY HANDLER (CONTACT PAGE)
========================================== */
export function sendContactInquiry(event) {
  event.preventDefault();
  
  const form = event.target;
  const name = form.name.value;
  const email = form.email.value;
  const country = form.country.value;
  const phone = form.phone.value || "Not provided";
  const purpose = form.purpose.value;
  const artwork = form.artwork.value || "General Inquiries";
  const message = form.message.value;
  
  const lead = captureLeadDetails();
  
  const emailBody = `Hello,

Inquiry from Contact Page:
Purpose: ${purpose}
Artwork of Interest: ${artwork}

Customer Details:
Name: ${name}
Email: ${email}
Phone: ${phone}
Country: ${country}

Inquiry Message:
${message}

---
Lead Details:
Date: ${lead.date}
Browser: ${lead.browser}
Source URL: ${lead.sourceUrl}
`;

  if (typeof emailjs !== 'undefined' && EMAILJS_SERVICE_ID !== "YOUR_SERVICE_ID" && EMAILJS_PUBLIC_KEY !== "YOUR_PUBLIC_KEY") {
    const statusText = document.getElementById("contact-form-status");
    if (statusText) {
      statusText.innerText = "Sending inquiry...";
      statusText.style.color = "var(--muted)";
    }
    
    emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, {
      from_name: name,
      from_email: email,
      phone: phone,
      country: country,
      purpose: purpose,
      artwork_name: artwork,
      artwork_code: "N/A",
      category: "Contact Form",
      message: message,
      lead_date: lead.date,
      lead_browser: lead.browser,
      lead_source: lead.sourceUrl
    }).then(function() {
      if (statusText) {
        statusText.innerText = "Thank you! Your message has been sent successfully.";
        statusText.style.color = "var(--sage)";
      }
      form.reset();
    }, function(error) {
      console.error("EmailJS failed:", error);
      if (statusText) {
        statusText.innerText = "Failed to send via form service. Opening email client instead...";
        statusText.style.color = "var(--clay)";
      }
      openMailto("hello.shwetastudio@gmail.com", `Studio Inquiry [${purpose}]: ${artwork}`, emailBody, "contact-form-status");
    });
  } else {
    openMailto("hello.shwetastudio@gmail.com", `Studio Inquiry [${purpose}]: ${artwork}`, emailBody, "contact-form-status");
  }
}

/* ==========================================
   GENERAL INQUIRY HANDLER (HOMEPAGE)
========================================== */
export function sendGeneralInquiry(event) {
  event.preventDefault();
  
  const form = event.target;
  const name = form.name.value;
  const email = form.email.value;
  const country = form.country.value;
  const purpose = form.purpose.value;
  const message = form.message.value;
  
  const lead = captureLeadDetails();
  
  const emailBody = `Hello,

General Inquiry from Shweta Studio Homepage:
Purpose: ${purpose}

Customer Details:
Name: ${name}
Email: ${email}
Country: ${country}

Inquiry Message:
${message}

---
Lead Details:
Date: ${lead.date}
Browser: ${lead.browser}
Source URL: ${lead.sourceUrl}
`;

  if (typeof emailjs !== 'undefined' && EMAILJS_SERVICE_ID !== "YOUR_SERVICE_ID" && EMAILJS_PUBLIC_KEY !== "YOUR_PUBLIC_KEY") {
    const statusText = document.getElementById("home-form-status");
    if (statusText) {
      statusText.innerText = "Sending inquiry...";
      statusText.style.color = "var(--muted)";
    }
    
    emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, {
      from_name: name,
      from_email: email,
      phone: "Not provided",
      country: country,
      purpose: purpose,
      artwork_name: "General Studio Inquiry",
      artwork_code: "N/A",
      category: "General",
      message: message,
      lead_date: lead.date,
      lead_browser: lead.browser,
      lead_source: lead.sourceUrl
    }).then(function() {
      if (statusText) {
        statusText.innerText = "Thank you! Your message has been sent successfully.";
        statusText.style.color = "var(--sage)";
      }
      form.reset();
    }, function(error) {
      console.error("EmailJS failed:", error);
      if (statusText) {
        statusText.innerText = "Failed to send via form service. Opening email client instead...";
        statusText.style.color = "var(--clay)";
      }
      openMailto("hello.shwetastudio@gmail.com", `General Studio Inquiry: ${purpose}`, emailBody, "home-form-status");
    });
  } else {
    openMailto("hello.shwetastudio@gmail.com", `General Studio Inquiry: ${purpose}`, emailBody, "home-form-status");
  }
}

// Expose functions to the window object for inline HTML triggers
window.sendInquiry = sendInquiry;
window.triggerDirectInquiry = triggerDirectInquiry;
window.sendContactInquiry = sendContactInquiry;
window.sendGeneralInquiry = sendGeneralInquiry;
