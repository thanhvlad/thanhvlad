import { vitePlugin as remix } from "@remix-run/dev";
import { installGlobals } from "@remix-run/node";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

installGlobals({ nativeFetch: true });

// Shopify tunnels (cloudflare / ngrok) terminate TLS in front of Vite, so the
// HMR websocket has to be told which host and port the browser can actually reach.
const host = (process.env.SHOPIFY_APP_URL ?? "http://localhost")
  .replace(/https?:\/\//, "")
  .replace(/\/$/, "");

const hmrConfig =
  host === "localhost"
    ? { protocol: "ws" as const, host: "localhost", port: 64999, clientPort: 64999 }
    : {
        protocol: "wss" as const,
        host,
        port: Number(process.env.FRONTEND_PORT) || 8002,
        clientPort: 443,
      };

export default defineConfig({
  server: {
    allowedHosts: [host],
    cors: { preflightContinue: true },
    port: Number(process.env.PORT || 3000),
    hmr: hmrConfig,
    fs: { allow: ["app", "node_modules"] },
  },
  plugins: [
    remix({
      ignoredRouteFiles: ["**/.*"],
      future: {
        v3_fetcherPersist: true,
        v3_relativeSplatPath: true,
        v3_throwAbortReason: true,
        v3_lazyRouteDiscovery: true,
        v3_singleFetch: false,
        v3_routeConfig: false,
      },
    }),
    tsconfigPaths(),
  ],
  build: { assetsInlineLimit: 0 },
  optimizeDeps: { include: ["@shopify/app-bridge-react", "@shopify/polaris"] },
});
