import { defineConfig, Plugin } from 'vite';

// Vite plugin: prepend `self.ort = require("onnxruntime-common")` to ort-web.min.js
// so that when the UMD wrapper calls `e(t.ort)`, t.ort is already populated.
// We do this as a transform plugin (not a patch) so it survives cache clears.
function ortWebPatchPlugin(): Plugin {
  return {
    name: 'ort-web-patch',
    transform(code, id) {
      if (!id.includes('onnxruntime-web') || !id.includes('ort-web.min.js')) return null;
      // 1. Prepend: give ort-web's UMD the ort-common module as `self.ort` so that
      //    its internal `registerBackend` calls don't throw "cannot read 'registerBackend'".
      // 2. Append: after the UMD IIFE runs it overwrites self.ort with the full ort-web API
      //    (InferenceSession, Tensor, env, …). Export that as the ESM default so that
      //    backends/onnx.js's `ONNX = ONNX_WEB.default ?? ONNX_WEB` resolves correctly.
      const prefix = `import * as __ort_common_ns__ from 'onnxruntime-common';\nif (typeof self !== 'undefined') { self.ort = __ort_common_ns__; }\n`;
      const suffix = `\nexport default (typeof self !== 'undefined' ? self.ort : undefined);\n`;
      return { code: prefix + code + suffix, map: null };
    },
  };
}

// https://vitejs.dev/config
export default defineConfig({
  plugins: [ortWebPatchPlugin()],
  optimizeDeps: {
    // Prevent Vite from pre-bundling these — they use dynamic imports for ONNX
    // WASM binaries that Vite's optimizer would break.
    exclude: ['@xenova/transformers', 'onnxruntime-web', 'onnxruntime-node'],
  },
  worker: {
    format: 'es',
    plugins: () => [ortWebPatchPlugin()],
  },
});
