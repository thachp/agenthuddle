import { fileURLToPath } from "node:url";
import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";
import vinext from "vinext";

export default defineConfig({
  server: { host: "127.0.0.1", port: 3000, strictPort: true, allowedHosts: ["app.localhost"] },
  // Its browser build decodes HTML entities with `document`, which agent text's parser doesn't have in a worker.
  resolve: { alias: { "decode-named-character-reference": fileURLToPath(new URL("./node_modules/decode-named-character-reference/index.js", import.meta.url)) } },
  plugins: [vinext(), cloudflare({ viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] } })],
});
