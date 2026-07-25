/*
==========================================
FILE: animations.js
PURPOSE: Intersection Observer scroll-reveal animations for elements containing the data-reveal attribute.
Author: Shweta Studio
==========================================
*/

/* ==========================================
   SCROLL REVEAL ANIMATIONS
========================================== */
export function initScrollReveal() {
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        }
      });
    },
    {
      threshold: 0.16,
      rootMargin: "0px 0px -40px 0px"
    }
  );
  
  document.querySelectorAll("[data-reveal]").forEach((element) => {
    observer.observe(element);
  });
}
