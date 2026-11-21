const VAPID_PUBLIC = "BDBX0KVOAd3jiJw1uNxM3M-zqYp1TdAdtmlw3nmkWJqnDcMrpAwQsUUG0DEMdcWZDvxwjAi91kRvm2PG_fczgR8";
const VAPID_JWK = {
  kty: "EC",
  crv: "P-256",
  d: "vctlfoDpiP1OiYN1LZ392OYxjUpk5ytRRy4GmvLT1Ho",
  x: "MFfQpU4B3eOInDW43Ezcz7OpinVN0B22aXDeeaRYmqc",
  y: "DcMrpAwQsUUG0DEMdcWZDvxwjAi91kRvm2PG_fczgR8"
};
const SUBJECT = "mailto:kontak@kontak.app";

export function vapidPublicKey() {
  return VAPID_PUBLIC;
}

function b64urlToBytes(s) {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64url(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function concat(...parts) {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

async function encryptPayload(p256dh, auth, payload) {
  const userPublic = b64urlToBytes(p256dh);
  const authSecret = b64urlToBytes(auth);
  const local = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const remote = await crypto.subtle.importKey("raw", userPublic, { name: "ECDH", namedCurve: "P-256" }, true, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: remote }, local.privateKey, 256));
  const localPublic = new Uint8Array(await crypto.subtle.exportKey("raw", local.publicKey));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const ikm = await hkdf(authSecret, shared, concat(new TextEncoder().encode("WebPush: info\0"), userPublic, localPublic), 32);
  const keyBytes = await hkdf(salt, ikm, new TextEncoder().encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, new TextEncoder().encode("Content-Encoding: nonce\0"), 12);
  const aes = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
  const plain = concat(new TextEncoder().encode(payload), new Uint8Array([2]));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, plain));
  const header = new Uint8Array(21 + localPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = localPublic.length;
  header.set(localPublic, 21);
  return concat(header, cipher);
}

async function vapidAuth(endpoint) {
  const aud = new URL(endpoint).origin;
  const header = bytesToB64url(new TextEncoder().encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = bytesToB64url(new TextEncoder().encode(JSON.stringify({
    aud,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: SUBJECT
  })));
  const key = await crypto.subtle.importKey("jwk", VAPID_JWK, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(header + "." + body)));
  return "vapid t=" + header + "." + body + "." + bytesToB64url(sig) + ", k=" + VAPID_PUBLIC;
}

export async function sendWebPush(sub, payload, urgent) {
  const body = await encryptPayload(sub.p256dh, sub.auth, payload);
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      Authorization: await vapidAuth(sub.endpoint),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: urgent ? "120" : "86400",
      Urgency: urgent ? "high" : "normal"
    },
    body
  });
  return res.status;
}
