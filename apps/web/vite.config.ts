import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";
import vinext from "vinext";

export default defineConfig({
  server: { host: "127.0.0.1", port: 3000, strictPort: true, allowedHosts: ["app.localhost"] },
  plugins: [vinext(), cloudflare({ viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] } })],
});
