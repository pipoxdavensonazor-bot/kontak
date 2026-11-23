// Optional SMS phone verification (v25).
// We generate and check a 6-digit code in D1, then send it through Bird's
// current SMS API (POST /v1/sms/messages) so the Haitian Creole wording,
// expiry, attempt cap and rate limits stay under our control.
//
// Bird Verify would be a shorter integration (Bird stores the code), but it
// would not give us a custom "Kòd verifikasyon Kontak ou se: 123456" text,
// per-IP / daily caps, a 60s resend cooldown, or a fake sender for tests
// and previews. The official send API uses Authorization: Bearer <bk_…>
// (workspace keys). The retired Engagement Platform AccessKey +
// /workspaces/{id}/channels/{id}/messages path is not used.
//
// Feature flag: without BIRD_ACCESS_KEY the flow is off, unless
// SMS_FAKE_SENDER=1 (previews and tests). Existing users are never forced
// to verify; users.phone_verified_at stays NULL until a correct code.

import { sessionUser } from "./session.js";

export const OTP = {
  LENGTH: 6,
  EXPIRY_MS: 10 * 60 * 1000,
  MAX_ATTEMPTS: 5,
  RESEND_MS: 60 * 1000,
  DAILY_PER_PHONE: 5,
  DAILY_PER_IP: 20,
  IP_WINDOW_MS: 10 * 60 * 1000,
  IP_WINDOW_MAX: 8
};

export const OTP_TEXT_PREFIX = "Kòd verifikasyon Kontak ou se: ";

export function verificationMode(env) {
  if (env && env.BIRD_ACCESS_KEY) return "bird";
  if (env && (env.SMS_FAKE_SENDER === "1" || env.SMS_FAKE_SENDER === "true")) return "fake";
  return "off";
}

export function otpMessage(code) {
  return OTP_TEXT_PREFIX + String(code);
}

// Stored form: digits only, no plus. An 8-digit local number is treated as Haiti (+509).
export function normalizePhone(input, defaultCc = "509") {
  let d = String(input || "").replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.length === 8) d = defaultCc + d;
  if (d.length < 8 || d.length > 15) return null;
  return d;
}

export function toE164(digits) {
  const d = normalizePhone(digits);
  return d ? "+" + d : null;
}

export function isHaiti(digits) {
  const d = String(digits || "").replace(/\D/g, "");
  return d.length === 11 && d.startsWith("509");
}

export function generateOtp() {
  const bytes = new Uint8Array(OTP.LENGTH);
  const out = [];
  crypto.getRandomValues(bytes);
  for (let i = 0; i < OTP.LENGTH; i++) {
    let b = bytes[i];
    // Rejection sampling would need a loop per digit; a fresh byte < 250 is unbiased mod 10.
    while (b >= 250) {
      const again = new Uint8Array(1);
      crypto.getRandomValues(again);
      b = again[0];
    }
    out.push(String(b % 10));
  }
  return out.join("");
}

function randomHex(bytes) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hashOtp(code, salt, phone) {
  return sha256Hex(String(salt) + ":" + String(phone) + ":" + String(code));
}

export function timingSafeEqual(a, b) {
  const A = String(a);
  const B = String(b);
  const len = Math.max(A.length, B.length, 1);
  let diff = A.length ^ B.length;
  for (let i = 0; i < len; i++) {
    diff |= (A.charCodeAt(i) || 0) ^ (B.charCodeAt(i) || 0);
  }
  return diff === 0;
}

export function birdHost(key, override) {
  if (override) return String(override).replace(/\/$/, "");
  const k = String(key || "");
  if (k.startsWith("bk_eu1_") || k.startsWith("bm_eu1_")) return "https://eu1.platform.bird.com";
  return "https://us1.platform.bird.com";
}

export function buildBirdSmsRequest(env, e164, text, { idempotencyKey } = {}) {
  const key = env && env.BIRD_ACCESS_KEY;
  const headers = {
    Authorization: "Bearer " + key,
    "Content-Type": "application/json"
  };
  if (idempotencyKey) headers["Idempotency-Key"] = String(idempotencyKey).slice(0, 256);
  return {
    url: birdHost(key, env && env.BIRD_API_HOST) + "/v1/sms/messages",
    headers,
    body: {
      to: e164,
      from: (env && env.BIRD_SENDER) || "KONTAK",
      text,
      category: "authentication"
    }
  };
}

export function clientIp(request) {
  const raw = request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "";
  return String(raw).split(",")[0].trim().slice(0, 64);
}

const json = (body, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function ensureVerifySchema(env) {
  if (!env || !env.DB) return;
  if (!env._verifySchema) {
    env._verifySchema = (async () => {
      const sqls = [
        "ALTER TABLE users ADD COLUMN phone_verified_at INTEGER",
        "CREATE TABLE IF NOT EXISTS phone_otps (id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT NOT NULL, user_id INTEGER NOT NULL, code_hash TEXT NOT NULL, salt TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER, ip TEXT, sender TEXT)",
        "CREATE INDEX IF NOT EXISTS idx_phone_otps_phone_created ON phone_otps(phone, created_at)",
        "CREATE INDEX IF NOT EXISTS idx_phone_otps_user ON phone_otps(user_id, created_at)"
      ];
      for (const sql of sqls) {
        try { await env.DB.prepare(sql).run(); } catch {}
      }
    })();
  }
  return env._verifySchema;
}

async function countOtps(env, where, binds) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM phone_otps WHERE " + where).bind(...binds).first();
  return Number(row && row.n) || 0;
}

export async function checkSendLimits(env, phone, ip, now) {
  const last = await env.DB.prepare(
    "SELECT created_at FROM phone_otps WHERE phone = ? ORDER BY id DESC LIMIT 1"
  ).bind(phone).first();
  if (last && now - Number(last.created_at) < OTP.RESEND_MS) {
    const retryAfter = Math.ceil((OTP.RESEND_MS - (now - Number(last.created_at))) / 1000);
    return { status: 429, body: { error: "cooldown", retryAfter } };
  }
  const day = now - 24 * 60 * 60 * 1000;
  const sentPhone = await countOtps(
    env,
    "phone = ? AND created_at > ? AND sender IN ('bird', 'fake', 'pending')",
    [phone, day]
  );
  if (sentPhone >= OTP.DAILY_PER_PHONE) return { status: 429, body: { error: "daily-limit" } };
  if (ip) {
    const sentIp = await countOtps(
      env,
      "ip = ? AND created_at > ? AND sender IN ('bird', 'fake', 'pending')",
      [ip, day]
    );
    if (sentIp >= OTP.DAILY_PER_IP) return { status: 429, body: { error: "slow-down" } };
    const recentIp = await countOtps(env, "ip = ? AND created_at > ?", [ip, now - OTP.IP_WINDOW_MS]);
    if (recentIp >= OTP.IP_WINDOW_MAX) return { status: 429, body: { error: "slow-down" } };
  }
  return null;
}

export async function requestVerification(env, { userId, ip, now = Date.now(), fetchImpl = fetch } = {}) {
  const mode = verificationMode(env);
  if (mode === "off") return { status: 404, body: { error: "sms-off", enabled: false } };
  await ensureVerifySchema(env);

  const user = await env.DB.prepare("SELECT id, phone, phone_verified_at FROM users WHERE id = ?").bind(userId).first();
  if (!user) return { status: 401, body: { error: "auth" } };
  if (user.phone_verified_at) return { status: 409, body: { error: "already-verified", verified: true } };

  const phone = normalizePhone(user.phone);
  const e164 = toE164(phone);
  if (!phone || !e164) return { status: 400, body: { error: "bad-phone" } };

  const limited = await checkSendLimits(env, phone, ip, now);
  if (limited) return limited;

  const code = generateOtp();
  const salt = randomHex(16);
  const codeHash = await hashOtp(code, salt, phone);
  const expiresAt = now + OTP.EXPIRY_MS;
  const ins = await env.DB.prepare(
    "INSERT INTO phone_otps (phone, user_id, code_hash, salt, attempts, created_at, expires_at, consumed_at, ip, sender) VALUES (?, ?, ?, ?, 0, ?, ?, NULL, ?, ?)"
  ).bind(phone, userId, codeHash, salt, now, expiresAt, ip || "", "pending").run();
  const otpId = ins.meta && ins.meta.last_row_id;

  if (mode === "fake") {
    await env.DB.prepare("UPDATE phone_otps SET sender = 'fake' WHERE id = ?").bind(otpId).run();
    console.log("otp: fake SMS queued for " + phone.replace(/^(\d{3,4})\d+(\d{2})$/, "$1****$2"));
    return { status: 200, body: { ok: true, expiresIn: OTP.EXPIRY_MS / 1000, cooldown: OTP.RESEND_MS / 1000 } };
  }

  const req = buildBirdSmsRequest(env, e164, otpMessage(code), {
    idempotencyKey: "kontak-otp/" + userId + "/" + otpId
  });
  let res;
  try {
    res = await fetchImpl(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(req.body) });
  } catch (e) {
    console.warn("otp: Bird SMS unreachable", e && e.message);
  }
  if (!res || (res.status !== 202 && res.status !== 200)) {
    await env.DB.prepare("UPDATE phone_otps SET sender = 'failed' WHERE id = ?").bind(otpId).run();
    console.warn("otp: Bird SMS send failed", res && res.status);
    return { status: 503, body: { error: "sms-unavailable" } };
  }
  await env.DB.prepare("UPDATE phone_otps SET sender = 'bird' WHERE id = ?").bind(otpId).run();
  return { status: 200, body: { ok: true, expiresIn: OTP.EXPIRY_MS / 1000, cooldown: OTP.RESEND_MS / 1000 } };
}

export async function checkVerification(env, { userId, code, now = Date.now() } = {}) {
  const mode = verificationMode(env);
  if (mode === "off") return { status: 404, body: { error: "sms-off", enabled: false } };
  await ensureVerifySchema(env);

  const raw = String(code || "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(raw)) return { status: 400, body: { error: "bad-input" } };

  const user = await env.DB.prepare("SELECT id, phone, phone_verified_at FROM users WHERE id = ?").bind(userId).first();
  if (!user) return { status: 401, body: { error: "auth" } };
  if (user.phone_verified_at) return { status: 200, body: { ok: true, verified: true } };

  const phone = normalizePhone(user.phone);
  const otp = await env.DB.prepare(
    "SELECT * FROM phone_otps WHERE user_id = ? AND phone = ? AND consumed_at IS NULL ORDER BY id DESC LIMIT 1"
  ).bind(userId, phone).first();

  const salt = otp ? otp.salt : "0".repeat(32);
  const expected = otp ? otp.code_hash : "0".repeat(64);
  const actual = await hashOtp(raw, salt, phone || "0");
  const match = !!(otp && timingSafeEqual(actual, expected));

  if (!otp || Number(otp.expires_at) < now) return { status: 400, body: { error: "expired" } };
  if (Number(otp.attempts) >= OTP.MAX_ATTEMPTS) return { status: 429, body: { error: "too-many-tries" } };
  if (!match) {
    const attempts = Number(otp.attempts) + 1;
    await env.DB.prepare("UPDATE phone_otps SET attempts = ? WHERE id = ?").bind(attempts, otp.id).run();
    if (attempts >= OTP.MAX_ATTEMPTS) {
      return { status: 429, body: { error: "too-many-tries" } };
    }
    return { status: 400, body: { error: "bad-code", remaining: OTP.MAX_ATTEMPTS - attempts } };
  }

  await env.DB.prepare("UPDATE phone_otps SET consumed_at = ?, attempts = attempts + 1 WHERE id = ?").bind(now, otp.id).run();
  await env.DB.prepare("UPDATE users SET phone_verified_at = ? WHERE id = ? AND phone = ?").bind(now, userId, phone).run();
  await env.DB.prepare("UPDATE phone_otps SET consumed_at = COALESCE(consumed_at, ?) WHERE user_id = ? AND consumed_at IS NULL").bind(now, userId).run();
  return { status: 200, body: { ok: true, verified: true } };
}

export async function handleVerify(request, env, url) {
  const mode = verificationMode(env);
  const path = url.pathname;

  if (path === "/verify/status" && request.method === "GET") {
    const userId = await sessionUser(request, env);
    if (!userId) return json({ enabled: mode !== "off" });
    await ensureVerifySchema(env);
    const user = await env.DB.prepare("SELECT phone, phone_verified_at FROM users WHERE id = ?").bind(userId).first();
    return json({
      enabled: mode !== "off",
      verified: !!(user && user.phone_verified_at),
      phone: user ? user.phone : null
    });
  }

  if (mode === "off") return json({ error: "sms-off", enabled: false }, 404);

  const userId = await sessionUser(request, env);
  if (!userId) return json({ error: "auth" }, 401);

  if (path === "/verify/request" && request.method === "POST") {
    const result = await requestVerification(env, { userId, ip: clientIp(request) });
    return json(result.body, result.status);
  }
  if (path === "/verify/check" && request.method === "POST") {
    let body = {};
    try { body = await request.json(); } catch { return json({ error: "bad-input" }, 400); }
    const result = await checkVerification(env, { userId, code: body && body.code, ip: clientIp(request) });
    return json(result.body, result.status);
  }
  return json({ error: "not-found" }, 404);
}
