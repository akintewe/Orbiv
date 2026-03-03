import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig({
  build: {
    rollupOptions: {
      external: [
        // Electron APIs — provided by the Electron runtime, never bundle
        'electron',
      ],
    },
  },
});
