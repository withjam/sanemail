import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

/**
 * Backend origin for dev proxy. Use API_PORT (not PORT): many environments set
 * PORT to the Vite port (5173), which would proxy /api to the wrong process.
 * Override fully with VITE_API_PROXY=http://127.0.0.1:3000
 */
const apiProxyOrigin =
  process.env.VITE_API_PROXY ||
  `http://${process.env.VITE_PROXY_API_HOST || "127.0.0.1"}:${process.env.API_PORT || "3000"}`;

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["pwa-icon.svg"],
      manifest: {
        name: "Togo Mail",
        short_name: "Togo Mail",
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
      "/api": apiProxyOrigin,
      "/connect": apiProxyOrigin,
      "/oauth": apiProxyOrigin,
    },
  },
});
