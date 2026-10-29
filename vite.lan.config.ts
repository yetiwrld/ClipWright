import { mergeConfig } from 'vite';
import defaultConfig, { developmentHeaders } from './vite.config';

// Opt-in only: exposes the dev server for Arena/sandbox preview hosts. Never use for normal local development.
const previewCsp = developmentHeaders['Content-Security-Policy'].replace(
  'ws://127.0.0.1:5174',
  'ws://127.0.0.1:5174 wss://*.e2b.app',
);

export default mergeConfig(defaultConfig, {
  server: {
    host: '0.0.0.0',
    allowedHosts: ['.e2b.app'],
    headers: { ...developmentHeaders, 'Content-Security-Policy': previewCsp },
  },
});
