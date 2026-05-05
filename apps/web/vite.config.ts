import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["pwa-icon.svg"],
      manifest: {
        name: "SaneMail",
        short_name: "SaneMail",
        description: "A calmer personal email surface.",
        theme_color: "#f8fafc",
        background_color: "#f8fafc",
        display: "standalone",
        scope: "/",
        start_url: "/",
        icons: [
          {
            src: "/pwa-icon.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "any maskable",
          },
        ],
      },
      workbox: {
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api\//, /^\/connect\//, /^\/oauth\//],
        globPatterns: ["**/*.{js,css,html,svg,png,ico,txt,json}"],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith("/api/"),
            handler: "NetworkFirst",
            options: {
              cacheName: "sanemail-api",
              networkTimeoutSeconds: 3,
              expiration: {
                maxEntries: 80,
                maxAgeSeconds: 60 * 60 * 24,
              },
            },
          },
        ],
      },
    }),
  ],
  server: {
    port: 5173,
    host: "127.0.0.1",
    proxy: {
      "/api": "http://127.0.0.1:3000",
      "/connect": "http://127.0.0.1:3000",
      "/oauth": "http://127.0.0.1:3000",
    },
  },
});
