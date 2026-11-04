import { generateKeyPairSync } from "node:crypto";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// A throwaway key per run. Tests sign as the gateway, and the Worker verifies with the public half.
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pub = publicKey.export({ format: "jwk" });

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          ASSERTION_KEYS: JSON.stringify({ test: pub.x }),
          TEST_SIGNING_JWK: JSON.stringify(privateKey.export({ format: "jwk" })),
        },
      },
    }),
  ],
  test: { testTimeout: 30000 },
});
