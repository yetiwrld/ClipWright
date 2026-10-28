import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const developmentHeaders = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-src 'none'",
    "form-action 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' blob: file:",
    "connect-src 'self' http://127.0.0.1:5174 ws://127.0.0.1:5173 ws://127.0.0.1:5174 wss:",
    "worker-src 'self' blob:",
  ].join('; '),
};

export default defineConfig({
  plugins: [react()],
  server: { host: '0.0.0.0', allowedHosts: true, headers: developmentHeaders },
  preview: { headers: developmentHeaders },
});
