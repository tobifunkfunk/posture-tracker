import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import basicSsl from '@vitejs/plugin-basic-ssl';

export default defineConfig({
  /*
   * getUserMedia needs a secure context. http://localhost already counts as
   * one, so plain `npm run dev` stays on http and avoids a certificate the
   * browser has to be argued with. Reaching the dev server from the phone
   * over the LAN does need real HTTPS, which is what `npm run dev:lan` turns
   * on via this flag.
   */
  plugins: [
    ...(process.env.HTTPS ? [basicSsl()] : []),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/*.png'],
      manifest: {
        name: 'Meditation Posture Tracker',
        short_name: 'Posture',
        description: 'Tracks seated meditation posture and its trends over time. All processing stays on the device.',
        theme_color: '#12100e',
        background_color: '#12100e',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '.',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // The pose model alone is 5.5MB and the SIMD wasm runtime 11MB; the
        // default 2MB cap would silently drop both and break the app offline.
        maximumFileSizeToCacheInBytes: 14 * 1024 * 1024,
        globPatterns: ['**/*.{js,css,html,png,svg,wasm,task}'],
        globIgnores: [
          // Only one wasm variant is ever loaded. Precaching all three would
          // cost 32MB; the fallbacks are runtime-cached if a device needs them.
          '**/vision_wasm_nosimd_internal.*',
          '**/vision_wasm_module_internal.*',
          // The face model is opt-in, so it is fetched and cached on demand.
          '**/face_landmarker.task',
        ],
        runtimeCaching: [
          {
            urlPattern: /\/(models|wasm)\/.*\.(task|wasm|js)$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'mediapipe-assets',
              expiration: { maxEntries: 12 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
  server: { host: true },
  build: { target: 'es2022' },
});
