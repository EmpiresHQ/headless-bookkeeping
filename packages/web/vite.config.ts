import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Dev: proxy API + admin to the running Nest server so the SPA works against a
// local backend without a rebuild. Prod build is served by serve-static at /.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
      '/admin': 'http://localhost:3000',
      '/health': 'http://localhost:3000',
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
  },
});
