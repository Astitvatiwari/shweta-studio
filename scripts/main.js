/*
==========================================
FILE: main.js
PURPOSE: Main entry point for the modular JavaScript system. Initializes modules and sets ready states.
Author: Shweta Studio
==========================================
*/

/* ==========================================
   MODULE IMPORTS
========================================== */
import { initNavigation } from './navigation.js';
import { initHoverEffects } from './hover.js';
import { initScrollReveal } from './animations.js';

// Import modules with side effects (attaching window events)
import './gallery.js';
import './forms.js';

/* ==========================================
   INITIALIZATION
========================================== */
document.addEventListener("DOMContentLoaded", () => {
  // Set JS-ready state on body for styling and scroll reveal overrides
  document.body.classList.add("js-ready");
  
  // Initialize module behaviors
  initNavigation();
  initHoverEffects();
  initScrollReveal();
});
