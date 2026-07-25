/*
==========================================
FILE: navigation.js
PURPOSE: Mobile responsive header navigation menu toggles and event handlers.
Author: Shweta Studio
==========================================
*/

/* ==========================================
   NAVIGATION MODULE INITIALIZATION
========================================== */
export function initNavigation() {
  const menuToggle = document.querySelector(".menu-toggle");
  const siteNav = document.querySelector(".site-nav");
  
  if (menuToggle && siteNav) {
    if (menuToggle.dataset.navInitialized) return;
    menuToggle.dataset.navInitialized = "true";
    menuToggle.addEventListener("click", () => {
      const isOpen = siteNav.classList.toggle("is-open");
      menuToggle.setAttribute("aria-expanded", String(isOpen));
      if (isOpen) {
        document.body.style.overflow = "hidden";
      } else {
        document.body.style.overflow = "";
      }
    });
    
    siteNav.querySelectorAll("a").forEach((link) => {
      link.addEventListener("click", () => {
        siteNav.classList.remove("is-open");
        menuToggle.setAttribute("aria-expanded", "false");
        document.body.style.overflow = "";
      });
    });

    // Close menu when clicking outside
    document.addEventListener("click", (event) => {
      if (siteNav.classList.contains("is-open")) {
        if (!siteNav.contains(event.target) && !menuToggle.contains(event.target)) {
          siteNav.classList.remove("is-open");
          menuToggle.setAttribute("aria-expanded", "false");
          document.body.style.overflow = "";
        }
      }
    });

    window.addEventListener("resize", () => {
      if (window.innerWidth > 992) {
        siteNav.classList.remove("is-open");
        menuToggle.setAttribute("aria-expanded", "false");
        document.body.style.overflow = "";
      }
    });

    // Touch dropdown handling for desktop-width touch screens (like iPad)
    const dropdownTrigger = document.querySelector(".nav-dropdown-trigger");
    const dropdownWrapper = document.querySelector(".nav-dropdown-wrapper");
    
    if (dropdownTrigger && dropdownWrapper) {
      dropdownTrigger.addEventListener("click", (e) => {
        // Only run on viewports where the dropdown is hover-based (desktop width > 992px)
        if (window.innerWidth > 992 && window.matchMedia("(hover: none)").matches) {
          if (!dropdownWrapper.classList.contains("touch-active")) {
            e.preventDefault();
            dropdownWrapper.classList.add("touch-active");
            
            // Close dropdown if user clicks elsewhere
            const closeDropdown = (event) => {
              if (!dropdownWrapper.contains(event.target)) {
                dropdownWrapper.classList.remove("touch-active");
                document.removeEventListener("click", closeDropdown);
              }
            };
            // Use setTimeout to avoid catching the current click event
            setTimeout(() => {
              document.addEventListener("click", closeDropdown);
            }, 10);
          }
        }
      });
    }
  }
}
