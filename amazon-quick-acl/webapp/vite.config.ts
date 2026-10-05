import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Fail instead of silently moving to 5174 when 5173 is taken. The embed only works
    // from the exact origin in QUICK_ALLOWED_DOMAIN, so a quiet port change produces an
    // embed that refuses to load with nothing pointing at the cause.
    strictPort: true,
    // Proxy /api to the local embed-URL harness so the browser and the API share an
    // origin. That keeps the harness free of CORS headers and off any public interface.
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3001',
        // Rewrite Host to 127.0.0.1:3001. The harness accepts only its own loopback
        // Host, which is what shuts out DNS-rebinding requests aimed straight at :3001.
        changeOrigin: true,
      },
    },
  },
});
