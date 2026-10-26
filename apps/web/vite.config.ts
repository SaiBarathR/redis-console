import { readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { devServerPort, devWebPort } from "../../scripts/dev-ports.ts";
/**
 * Ships the repository's THIRD-PARTY-NOTICES (scripts/third-party-notices.ts) with the SPA as /THIRD-PARTY-NOTICES.txt,
 * linked from Account → About. A build without it fails: the bundle redistributes the code it lists.
 */
function thirdPartyNotices(): Plugin {
  return {
    name: "rconsole-third-party-notices",
    apply: "build",
    generateBundle() {
      const file = new URL("../../THIRD-PARTY-NOTICES", import.meta.url);
      this.emitFile({ type: "asset", fileName: "THIRD-PARTY-NOTICES.txt", source: readFileSync(file, "utf8") });
    },
  };
}
// The dev server and the API agree on ports (root `pnpm dev`; RCONSOLE_PORT, RCONSOLE_WEB_PORT): scripts/dev-ports.ts.
export default defineConfig({
  plugins: [react(), tailwindcss(), thirdPartyNotices()],
  server: {
    host: "127.0.0.1",
    port: devWebPort(),
    strictPort: true,
    proxy: { "/api": `http://127.0.0.1:${devServerPort()}` },
  },
  build: {
    sourcemap: false,
    target: "es2023",
    // CSP font-src 'self' forbids data: fonts; always emit font files.
    assetsInlineLimit: (file) => (file.endsWith(".woff2") ? false : undefined),
  },
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    restoreMocks: true,
  },
});
