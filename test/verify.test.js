import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import worker from "../src/worker.js";
import { call, register, connect, ORIGIN } from "./helpers.js";
import {
  generateOtp,
  hashOtp,
  timingSafeEqual,
  normalizePhone,
  toE164,
  isHaiti,
  otpMessage,
  buildBirdSmsRequest,
  birdHost,
  verificationMode,
  requestVerification,
  checkVerification,
  ensureVerifySchema,
  OTP,
  emailVerificationMode,
  normalizeEmail,
  parseSender,
  buildEmailMessage,
  EMAIL_SUBJECT,
  emailText,
  requestEmailVerification,
  checkEmailVerification
} from "../src/verify.js";

const DUMMY_KEY_US = "bk_us1_test_not_real";
const DUMMY_KEY_EU = "bk_eu1_test_not_real";

function fakeEnv(extra = {}) {
  return { ...env, SMS_FAKE_SENDER: "1", BIRD_SENDER: "KONTAK", BIRD_WORKSPACE_ID: "ws_test", ...extra };
}

function birdEnv(extra = {}) {
  return fakeEnv({ SMS_FAKE_SENDER: undefined, BIRD_ACCESS_KEY: DUMMY_KEY_US, ...extra });
}

async function verifyFetch(path, { token, method = "GET", body, env: e = env, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = "Bearer " + token;
  if (body !== undefined) h["Content-Type"] = "application/json";
  return worker.fetch(new Request(ORIGIN + path, {
    method,
    headers: h,
    body: body !== undefined ? JSON.stringify(body) : undefined
  }), e);
}

async function seedOtp(userId, phone, code, { now = Date.now(), expiresAt = now + OTP.EXPIRY_MS, attempts = 0, ip = "203.0.113.9" } = {}) {
  await ensureVerifySchema(env);
  const normalized = normalizePhone(phone);
  const salt = "a".repeat(32);
  const codeHash = await hashOtp(code, salt, normalized);
  await env.DB.prepare(
    "INSERT INTO phone_otps (phone, user_id, code_hash, salt, attempts, created_at, expires_at, consumed_at, ip, sender) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 'fake')"
  ).bind(normalized, userId, codeHash, salt, attempts, now, expiresAt, ip).run();
}

describe("phone normalization", () => {
  it("prefers Haitian 8-digit local numbers and accepts E.164 generally", () => {
    expect(normalizePhone("37123456")).toBe("50937123456");
    expect(normalizePhone("+509 3712-3456")).toBe("50937123456");
    expect(normalizePhone("0050937123456")).toBe("50937123456");
    expect(normalizePhone("50937123456")).toBe("50937123456");
    expect(toE164("37123456")).toBe("+50937123456");
    expect(isHaiti("50937123456")).toBe(true);
    expect(normalizePhone("+1 415 555 0100")).toBe("14155550100");
    expect(toE164("14155550100")).toBe("+14155550100");
    expect(isHaiti("14155550100")).toBe(false);
    expect(normalizePhone("123")).toBeNull();
    expect(toE164("")).toBeNull();
  });
});

describe("otp generation and hashing", () => {
  it("generates 6-digit codes and hashes them with a salt", async () => {
    const codes = new Set();
    for (let i = 0; i < 40; i++) {
      const code = generateOtp();
      expect(code).toMatch(/^\d{6}$/);
      codes.add(code);
    }
    expect(codes.size).toBeGreaterThan(20);
    const hash = await hashOtp("123456", "salt", "50937123456");
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toBe(await hashOtp("123457", "salt", "50937123456"));
    expect(hash).not.toBe(await hashOtp("123456", "other", "50937123456"));
    expect(timingSafeEqual(hash, hash)).toBe(true);
    expect(timingSafeEqual(hash, hash.slice(0, 63) + "0")).toBe(false);
    expect(otpMessage("123456")).toBe("Kòd verifikasyon Kontak ou se: 123456");
  });
});

describe("Bird request shape", () => {
  it("builds a Bearer SMS send to the regional host with sender KONTAK", () => {
    expect(verificationMode({})).toBe("off");
    expect(verificationMode({ SMS_FAKE_SENDER: "1" })).toBe("fake");
    expect(verificationMode({ BIRD_ACCESS_KEY: DUMMY_KEY_US })).toBe("bird");
    expect(birdHost(DUMMY_KEY_US)).toBe("https://us1.platform.bird.com");
    expect(birdHost(DUMMY_KEY_EU)).toBe("https://eu1.platform.bird.com");

    const req = buildBirdSmsRequest(
      { BIRD_ACCESS_KEY: DUMMY_KEY_US, BIRD_SENDER: "KONTAK" },
      "+50937123456",
      otpMessage("123456"),
      { idempotencyKey: "kontak-otp/1/2" }
    );
    expect(req.url).toBe("https://us1.platform.bird.com/v1/sms/messages");
    expect(req.headers.Authorization).toBe("Bearer " + DUMMY_KEY_US);
    expect(req.headers["Content-Type"]).toBe("application/json");
    expect(req.headers["Idempotency-Key"]).toBe("kontak-otp/1/2");
    expect(req.body).toEqual({
      to: "+50937123456",
      from: "KONTAK",
      text: "Kòd verifikasyon Kontak ou se: 123456",
      category: "authentication"
    });
  });

  it("sends that payload through a mocked fetch when requesting a code", async () => {
    const c = await register("Bird Shape");
    const fetches = [];
    const fetchImpl = async (url, init) => {
      fetches.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ id: "sms_test", status: "accepted" }), { status: 202 });
    };
    const result = await requestVerification(birdEnv(), {
      userId: c.user.id,
      ip: "203.0.113.10",
      fetchImpl
    });
    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
    expect(fetches).toHaveLength(1);
    expect(fetches[0].url).toBe("https://us1.platform.bird.com/v1/sms/messages");
    expect(fetches[0].headers.Authorization).toBe("Bearer " + DUMMY_KEY_US);
    expect(fetches[0].body.to).toBe("+" + c.phone);
    expect(fetches[0].body.from).toBe("KONTAK");
    expect(fetches[0].body.category).toBe("authentication");
    expect(fetches[0].body.text).toMatch(/^Kòd verifikasyon Kontak ou se: \d{6}$/);
    // The plaintext code is not returned to the client.
    expect(JSON.stringify(result.body)).not.toMatch(/\d{6}/);
    c.close();
  });
});

describe("verification HTTP and flow", () => {
  it("stays off when the Bird key and fake sender are missing", async () => {
    const c = await register("Otp Off");
    expect(c.user.phoneVerified).toBe(false);
    const status = await verifyFetch("/verify/status", { token: c.token, env });
    expect(status.status).toBe(200);
    const statusBody = await status.json();
    expect(statusBody).toMatchObject({ enabled: false, verified: false, phone: c.phone, emailVerified: false, email: null });
    expect(statusBody.emailEnabled).toBe(true); // wrangler.toml provides EMAIL + EMAIL_FROM
    const req = await verifyFetch("/verify/request", { token: c.token, method: "POST", body: {}, env });
    expect(req.status).toBe(404);
    expect((await req.json()).error).toBe("sms-off");
    // Login still works; verification is not required.
    const again = await connect();
    const login = await again.request({ type: "login", phone: c.phone, password: "motdepasse123" }, "auth-ok");
    expect(login.type).toBe("auth-ok");
    expect(login.user.phoneVerified).toBe(false);
    again.close();
    c.close();
  });

  it("sends a fake SMS, rejects a wrong code, then accepts the right one", async () => {
    const c = await register("Otp Ok");
    const e = fakeEnv();
    expect((await verifyFetch("/verify/request", { method: "POST", body: {}, env: e })).status).toBe(401);
    const sent = await verifyFetch("/verify/request", { token: c.token, method: "POST", body: {}, env: e, headers: { "CF-Connecting-IP": "203.0.113.20" } });
    expect(sent.status).toBe(200);
    expect((await sent.json()).ok).toBe(true);

    const tooSoon = await verifyFetch("/verify/request", { token: c.token, method: "POST", body: {}, env: e, headers: { "CF-Connecting-IP": "203.0.113.20" } });
    expect(tooSoon.status).toBe(429);
    expect((await tooSoon.json()).error).toBe("cooldown");

    const bad = await checkVerification(e, { userId: c.user.id, code: "000000" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("bad-code");
    expect(bad.body.remaining).toBe(4);

    const malformed = await checkVerification(e, { userId: c.user.id, code: "12ab" });
    expect(malformed).toEqual({ status: 400, body: { error: "bad-input" } });

    // Seed a known code on a fresh user to check the happy path without reading the SMS.
    const d = await register("Otp Known");
    await seedOtp(d.user.id, d.phone, "654321");
    const wrong = await verifyFetch("/verify/check", { token: d.token, method: "POST", body: { code: "111111" }, env: e });
    expect(wrong.status).toBe(400);
    expect((await wrong.json()).error).toBe("bad-code");
    const ok = await verifyFetch("/verify/check", { token: d.token, method: "POST", body: { code: "654321" }, env: e });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, verified: true });
    const row = await env.DB.prepare("SELECT phone_verified_at FROM users WHERE id = ?").bind(d.user.id).first();
    expect(Number(row.phone_verified_at)).toBeGreaterThan(0);
    const already = await requestVerification(e, { userId: d.user.id, ip: "203.0.113.21" });
    expect(already.status).toBe(409);
    expect(already.body.error).toBe("already-verified");

    const resumed = await connect();
    const resume = await resumed.request({ type: "resume", token: d.token }, "auth-ok");
    expect(resume.user.phoneVerified).toBe(true);
    resumed.close();
    c.close();
    d.close();
  });

  it("expires codes, caps attempts at 5, and applies daily and IP rate limits", async () => {
    const e = fakeEnv();
    const now = Date.now();

    const expiredUser = await register("Otp Expired");
    await seedOtp(expiredUser.user.id, expiredUser.phone, "111222", { now: now - 11 * 60 * 1000, expiresAt: now - 60 * 1000 });
    const expired = await checkVerification(e, { userId: expiredUser.user.id, code: "111222", now });
    expect(expired).toEqual({ status: 400, body: { error: "expired" } });
    const still = await env.DB.prepare("SELECT phone_verified_at FROM users WHERE id = ?").bind(expiredUser.user.id).first();
    expect(still.phone_verified_at).toBeFalsy();
    expiredUser.close();

    const tries = await register("Otp Tries");
    await seedOtp(tries.user.id, tries.phone, "222333", { now });
    for (let i = 1; i <= 4; i++) {
      const r = await checkVerification(e, { userId: tries.user.id, code: "000000", now });
      expect(r.body.error).toBe("bad-code");
      expect(r.body.remaining).toBe(5 - i);
    }
    const last = await checkVerification(e, { userId: tries.user.id, code: "000000", now });
    expect(last).toEqual({ status: 429, body: { error: "too-many-tries" } });
    const late = await checkVerification(e, { userId: tries.user.id, code: "222333", now });
    expect(late.body.error).toBe("too-many-tries");
    tries.close();

    const limited = await register("Otp Daily");
    const phone = normalizePhone(limited.phone);
    for (let i = 0; i < OTP.DAILY_PER_PHONE; i++) {
      const t = now - 120000 - i * 70 * 1000;
      await env.DB.prepare(
        "INSERT INTO phone_otps (phone, user_id, code_hash, salt, attempts, created_at, expires_at, ip, sender) VALUES (?, ?, 'x', 's', 0, ?, ?, '203.0.113.30', 'fake')"
      ).bind(phone, limited.user.id, t, t + OTP.EXPIRY_MS).run();
    }
    const daily = await requestVerification(e, { userId: limited.user.id, ip: "203.0.113.40", now });
    expect(daily.status).toBe(429);
    expect(daily.body.error).toBe("daily-limit");
    limited.close();

    const ipUser = await register("Otp Ip");
    for (let i = 0; i < OTP.IP_WINDOW_MAX; i++) {
      const t = now - 1000 - i * 1000;
      await env.DB.prepare(
        "INSERT INTO phone_otps (phone, user_id, code_hash, salt, attempts, created_at, expires_at, ip, sender) VALUES (?, ?, 'x', 's', 0, ?, ?, '198.51.100.7', 'failed')"
      ).bind("5093999" + String(1000 + i), ipUser.user.id, t, t + OTP.EXPIRY_MS).run();
    }
    const ipLimit = await requestVerification(e, { userId: ipUser.user.id, ip: "198.51.100.7", now });
    expect(ipLimit.status).toBe(429);
    expect(ipLimit.body.error).toBe("slow-down");
    ipUser.close();
  });

  it("does not call Bird when the fake sender is on, and reports 503 when Bird fails", async () => {
    const c = await register("Otp Fake");
    let called = 0;
    const fetchImpl = async () => { called += 1; return new Response("nope", { status: 500 }); };
    const fake = await requestVerification(fakeEnv(), { userId: c.user.id, ip: "203.0.113.50", fetchImpl });
    expect(fake.status).toBe(200);
    expect(called).toBe(0);

    const d = await register("Otp Fail");
    const fail = await requestVerification(birdEnv(), { userId: d.user.id, ip: "203.0.113.51", fetchImpl });
    expect(fail.status).toBe(503);
    expect(fail.body.error).toBe("sms-unavailable");
    expect(called).toBe(1);
    const row = await env.DB.prepare("SELECT sender FROM phone_otps WHERE user_id = ?").bind(d.user.id).first();
    expect(row.sender).toBe("failed");
    c.close();
    d.close();
  });
});

describe("service worker and public routes", () => {
  it("still serves the app when verification is off", async () => {
    expect((await call("/")).status).toBe(200);
    expect((await call("/verify/status")).status).toBe(200);
    expect(await (await call("/verify/status")).json()).toEqual({ enabled: false, emailEnabled: true });
  });
});


function emailEnv(extra = {}) {
  return { ...env, EMAIL_FAKE_SENDER: "1", EMAIL_FROM: "Kontak <no-reply@klirline.ca>", ...extra };
}

async function seedEmailOtp(userId, email, code, { now = Date.now(), expiresAt = now + OTP.EXPIRY_MS, attempts = 0, ip = "203.0.113.9" } = {}) {
  await ensureVerifySchema(env);
  const target = normalizeEmail(email);
  const salt = "b".repeat(32);
  const codeHash = await hashOtp(code, salt, target);
  await env.DB.prepare(
    "INSERT INTO email_otps (email, user_id, code_hash, salt, attempts, created_at, expires_at, consumed_at, ip, sender) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 'fake')"
  ).bind(target, userId, codeHash, salt, attempts, now, expiresAt, ip).run();
}

describe("email normalization and message shape", () => {
  it("normalizes addresses and builds the Creole Cloudflare payload", () => {
    expect(normalizeEmail("  Pierre@Klirline.CA ")).toBe("pierre@klirline.ca");
    expect(normalizeEmail("bad")).toBeNull();
    expect(normalizeEmail("a@b")).toBeNull();
    expect(parseSender("Kontak <no-reply@klirline.ca>")).toEqual({ name: "Kontak", email: "no-reply@klirline.ca" });
    expect(emailVerificationMode({})).toBe("off");
    expect(emailVerificationMode({ EMAIL_FAKE_SENDER: "1" })).toBe("fake");
    expect(emailVerificationMode({ EMAIL: { send: async () => {} }, EMAIL_FROM: "Kontak <no-reply@klirline.ca>" })).toBe("cloudflare");

    const msg = buildEmailMessage({ EMAIL_FROM: "Kontak <no-reply@klirline.ca>" }, "contact@klirline.ca", "123456");
    expect(msg.from).toEqual({ name: "Kontak", email: "no-reply@klirline.ca" });
    expect(msg.to).toBe("contact@klirline.ca");
    expect(msg.subject).toBe(EMAIL_SUBJECT);
    expect(msg.subject).toBe("Kòd verifikasyon Kontak");
    expect(msg.text).toContain("Kòd verifikasyon Kontak ou se: 123456");
    expect(msg.html).toContain("123456");
    expect(emailText("123456")).toContain("10 minit");
  });
});

describe("email verification flow", () => {
  it("stays off when EMAIL_FROM/binding and the fake sender are missing", async () => {
    const c = await register("Email Off");
    expect(c.user.emailVerified).toBe(false);
    const off = { ...env, EMAIL: undefined, EMAIL_FROM: undefined, EMAIL_FROM_ADDRESS: undefined, EMAIL_FAKE_SENDER: undefined };
    const status = await verifyFetch("/verify/status", { token: c.token, env: off });
    expect((await status.json()).emailEnabled).toBe(false);
    const req = await verifyFetch("/verify/email/request", { token: c.token, method: "POST", body: { email: "a@b.co" }, env: off });
    expect(req.status).toBe(404);
    expect((await req.json()).error).toBe("email-off");
    c.close();
  });

  it("sends a fake email, rejects a wrong code, then accepts the right one and stores the address", async () => {
    const c = await register("Email Ok");
    const e = emailEnv();
    expect((await verifyFetch("/verify/email/request", { method: "POST", body: { email: "one@klirline.ca" }, env: e })).status).toBe(401);

    const sent = await verifyFetch("/verify/email/request", {
      token: c.token, method: "POST", body: { email: "Pierre@Klirline.CA" }, env: e,
      headers: { "CF-Connecting-IP": "203.0.113.80" }
    });
    expect(sent.status).toBe(200);
    expect((await sent.json()).email).toBe("pierre@klirline.ca");

    const tooSoon = await verifyFetch("/verify/email/request", {
      token: c.token, method: "POST", body: { email: "pierre@klirline.ca" }, env: e,
      headers: { "CF-Connecting-IP": "203.0.113.80" }
    });
    expect(tooSoon.status).toBe(429);
    expect((await tooSoon.json()).error).toBe("cooldown");

    const d = await register("Email Known");
    await seedEmailOtp(d.user.id, "known@klirline.ca", "654321");
    const wrong = await verifyFetch("/verify/email/check", {
      token: d.token, method: "POST", body: { code: "111111", email: "known@klirline.ca" }, env: e
    });
    expect(wrong.status).toBe(400);
    expect((await wrong.json()).error).toBe("bad-code");
    const ok = await verifyFetch("/verify/email/check", {
      token: d.token, method: "POST", body: { code: "654321", email: "known@klirline.ca" }, env: e
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, verified: true, email: "known@klirline.ca" });
    const row = await env.DB.prepare("SELECT email, email_verified_at FROM users WHERE id = ?").bind(d.user.id).first();
    expect(row.email).toBe("known@klirline.ca");
    expect(Number(row.email_verified_at)).toBeGreaterThan(0);

    const already = await requestEmailVerification(e, { userId: d.user.id, email: "known@klirline.ca" });
    expect(already.status).toBe(409);
    expect(already.body.error).toBe("already-verified");

    const other = await register("Email Taken");
    const taken = await requestEmailVerification(e, { userId: other.user.id, email: "known@klirline.ca" });
    expect(taken.status).toBe(409);
    expect(taken.body.error).toBe("email-taken");

    const resumed = await connect();
    const resume = await resumed.request({ type: "resume", token: d.token }, "auth-ok");
    expect(resume.user.emailVerified).toBe(true);
    expect(resume.user.email).toBe("known@klirline.ca");
    resumed.close();
    c.close();
    d.close();
    other.close();
  });

  it("expires email codes, caps attempts at 5, and applies daily and IP rate limits", async () => {
    const e = emailEnv();
    const now = Date.now();

    const expiredUser = await register("Email Expired");
    await seedEmailOtp(expiredUser.user.id, "exp@klirline.ca", "111222", { now: now - 11 * 60 * 1000, expiresAt: now - 60 * 1000 });
    const expired = await checkEmailVerification(e, { userId: expiredUser.user.id, code: "111222", email: "exp@klirline.ca", now });
    expect(expired).toEqual({ status: 400, body: { error: "expired" } });
    expiredUser.close();

    const tries = await register("Email Tries");
    await seedEmailOtp(tries.user.id, "tries@klirline.ca", "222333", { now });
    for (let i = 1; i <= 4; i++) {
      const r = await checkEmailVerification(e, { userId: tries.user.id, code: "000000", email: "tries@klirline.ca", now });
      expect(r.body.error).toBe("bad-code");
      expect(r.body.remaining).toBe(5 - i);
    }
    const last = await checkEmailVerification(e, { userId: tries.user.id, code: "000000", email: "tries@klirline.ca", now });
    expect(last).toEqual({ status: 429, body: { error: "too-many-tries" } });
    const late = await checkEmailVerification(e, { userId: tries.user.id, code: "222333", email: "tries@klirline.ca", now });
    expect(late.body.error).toBe("too-many-tries");
    tries.close();

    const limited = await register("Email Daily");
    for (let i = 0; i < OTP.DAILY_PER_PHONE; i++) {
      const t = now - 120000 - i * 70 * 1000;
      await env.DB.prepare(
        "INSERT INTO email_otps (email, user_id, code_hash, salt, attempts, created_at, expires_at, ip, sender) VALUES (?, ?, 'x', 's', 0, ?, ?, '203.0.113.90', 'fake')"
      ).bind("daily@klirline.ca", limited.user.id, t, t + OTP.EXPIRY_MS).run();
    }
    const daily = await requestEmailVerification(e, { userId: limited.user.id, email: "daily@klirline.ca", ip: "203.0.113.91", now });
    expect(daily.status).toBe(429);
    expect(daily.body.error).toBe("daily-limit");
    limited.close();
  });

  it("calls the Cloudflare send() payload through a mock and does not return the code", async () => {
    const c = await register("Email BirdShape");
    const sent = [];
    const sendImpl = async (msg) => { sent.push(msg); return { messageId: "eml_test" }; };
    const result = await requestEmailVerification(
      { ...env, EMAIL_FROM: "Kontak <no-reply@klirline.ca>", EMAIL: { send: sendImpl } },
      { userId: c.user.id, email: "contact@klirline.ca", ip: "203.0.113.99", sendImpl }
    );
    expect(result.status).toBe(200);
    expect(JSON.stringify(result.body)).not.toMatch(/Kòd verifikasyon Kontak ou se: \d{6}/);
    expect(sent).toHaveLength(1);
    expect(sent[0].from).toEqual({ name: "Kontak", email: "no-reply@klirline.ca" });
    expect(sent[0].to).toBe("contact@klirline.ca");
    expect(sent[0].subject).toBe("Kòd verifikasyon Kontak");
    expect(sent[0].text).toMatch(/^Kòd verifikasyon Kontak ou se: \d{6}/);
    expect(sent[0].html).toMatch(/\d{6}/);
    c.close();
  });

  it("does not call send() in fake mode, and reports 503 when send fails", async () => {
    const c = await register("Email Fake");
    let called = 0;
    const sendImpl = async () => { called += 1; throw Object.assign(new Error("nope"), { code: "E_DELIVERY_FAILED" }); };
    const fake = await requestEmailVerification(emailEnv(), { userId: c.user.id, email: "fake@klirline.ca", ip: "203.0.113.70", sendImpl });
    expect(fake.status).toBe(200);
    expect(called).toBe(0);

    const d = await register("Email Fail");
    const fail = await requestEmailVerification(
      { ...env, EMAIL_FROM: "Kontak <no-reply@klirline.ca>", EMAIL: { send: sendImpl } },
      { userId: d.user.id, email: "fail@klirline.ca", ip: "203.0.113.71", sendImpl }
    );
    expect(fail.status).toBe(503);
    expect(fail.body.error).toBe("email-unavailable");
    expect(called).toBe(1);
    c.close();
    d.close();
  });
});
