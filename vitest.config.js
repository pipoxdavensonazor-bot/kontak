import path from "node:path";
import { webcrypto } from "node:crypto";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Throwaway VAPID pair generated for each test run (never written to disk).
async function testVapid() {
  const { publicKey, privateKey } = await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]
  );
  const raw = new Uint8Array(await webcrypto.subtle.exportKey("raw", publicKey));
  const jwk = await webcrypto.subtle.exportKey("jwk", privateKey);
  return { VAPID_PUBLIC: Buffer.from(raw).toString("base64url"), VAPID_JWK: JSON.stringify(jwk) };
}

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
      return {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations, ...(await testVapid()) }
        }
      };
    })
  ],
  test: {
    setupFiles: ["./test/apply-migrations.js"]
  }
});
