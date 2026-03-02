/**
 * FocusBubble – global.d.ts
 *
 * Augments the global Window interface so TypeScript knows about the
 * `window.focusBubble` API that preload.ts injects via contextBridge.
 *
 * This file is automatically picked up by TypeScript because it lives
 * in the `src/` folder included in the compilation.
 */

import type { FocusBubbleAPI } from './preload';

declare global {
  interface Window {
    focusBubble: FocusBubbleAPI;
  }
}

// This export makes this file a module (required to augment global scope)
export {};
