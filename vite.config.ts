import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    // Dev (localhost) uses an unrestricted key so generateContent isn't blocked
    // by the prod key's HTTP-referrer allowlist. Prod build keeps the
    // referrer-locked GEMINI_API_KEY so the public bundle never ships an open key.
    const apiKey = mode === 'production'
      ? env.GEMINI_API_KEY
      : (env.GEMINI_API_KEY_DEV || env.GEMINI_API_KEY);
    return {
      server: {
        port: 3000,
        host: '0.0.0.0',
        // Same-origin Firebase auth helper in dev (see firebase.ts authDomain override)
        proxy: {
          '/__/auth': {
            target: 'https://gen-lang-client-0579241284.firebaseapp.com',
            changeOrigin: true,
          },
          '/__/firebase': {
            target: 'https://gen-lang-client-0579241284.firebaseapp.com',
            changeOrigin: true,
          },
        },
      },
      plugins: [react()],
      define: {
        'process.env.API_KEY': JSON.stringify(apiKey),
        'process.env.GEMINI_API_KEY': JSON.stringify(apiKey)
      },
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      }
    };
});
