/*
==========================================
FILE: utils.js
PURPOSE: Shared utility helper functions for date, browser information, and email client failovers.
Author: Shweta Studio
==========================================
*/

/* ==========================================
   LEAD TRACKING UTILITIES
========================================== */
export function captureLeadDetails() {
  return {
    date: new Date().toLocaleString(),
    browser: navigator.userAgent,
    sourceUrl: window.location.href
  };
}

/* ==========================================
   EMAIL FAILOVER UTILITIES
========================================== */
export function openMailto(recipient, subject, body, statusElementId) {
  const mailtoUrl = `mailto:${recipient}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  window.open(mailtoUrl, '_blank');
  
  const statusText = document.getElementById(statusElementId);
  if (statusText) {
    statusText.innerText = "Inquiry pre-filled. Please check your email client to send.";
    statusText.style.color = "var(--muted)";
  }
}
