#!/usr/bin/env node
// Generates a new VAPID key pair for Web Push and prints it to stdout.
// Nothing is written to disk. Usage:
//   node scripts/gen-vapid.mjs            -> JSON { VAPID_PUBLIC, VAPID_JWK }
//   node scripts/gen-vapid.mjs --dotenv   -> lines for .dev.vars
// Then: npx wrangler secret put VAPID_PUBLIC  /  npx wrangler secret put VAPID_JWK
import { webcrypto as crypto } from "node:crypto";

const { publicKey, privateKey } = await crypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" },
  true,
  ["sign", "verify"]
);
const raw = new Uint8Array(await crypto.subtle.exportKey("raw", publicKey));
const jwk = await crypto.subtle.exportKey("jwk", privateKey);
const b64url = (bytes) => Buffer.from(bytes).toString("base64url");

const out = {
  VAPID_PUBLIC: b64url(raw),
  VAPID_JWK: JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d })
};

if (process.argv.includes("--dotenv")) {
  console.log(`VAPID_PUBLIC=${out.VAPID_PUBLIC}`);
  console.log(`VAPID_JWK='${out.VAPID_JWK}'`);
} else {
  console.log(JSON.stringify(out, null, 2));
}
