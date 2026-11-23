import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import worker, { iceServersFor } from "../src/worker.js";
import { call, connect, register, ORIGIN } from "./helpers.js";

describe("HTTP endpoints", () => {
  it("serves the app shell with build v26", async () => {
    const res = await call("/");
    expect(res.status).toBe(200);
    const app = await (await call("/app.js")).text();
    expect(app).toContain('BUILD = "v26"');
  });

  it("/vapid returns the public key from the secret", async () => {
    const res = await call("/vapid");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ key: env.VAPID_PUBLIC });
  });

  it("/vapid answers 503 when the secrets are missing", async () => {
    const res = await worker.fetch(new Request(ORIGIN + "/vapid"), { ...env, VAPID_PUBLIC: undefined, VAPID_JWK: undefined });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "vapid-missing" });
  });

  it("/turn requires a session", async () => {
    expect((await call("/turn")).status).toBe(401);
    expect((await call("/turn", { headers: { Authorization: "Bearer nope" } })).status).toBe(401);
  });

  it("/turn falls back to STUN only without Cloudflare Calls secrets", async () => {
    const c = await register("Turn Test");
    const res = await call("/turn", { headers: { Authorization: "Bearer " + c.token } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.turn).toBe(false);
    const urls = body.iceServers.flatMap((s) => [].concat(s.urls));
    expect(urls.every((u) => u.startsWith("stun:"))).toBe(true);
    expect(JSON.stringify(body)).not.toContain("openrelay");
    c.close();
  });

  it("iceServersFor never leaks a hard-coded TURN secret", async () => {
    const body = await iceServersFor({});
    expect(body.iceServers).toHaveLength(1);
    expect(body.turn).toBe(false);
  });

  it("/ws without upgrade is 426", async () => {
    expect((await call("/ws")).status).toBe(426);
  });

  it("rejects WebSocket upgrades without Origin or from a foreign origin", async () => {
    const none = await connect({ Upgrade: "websocket" });
    expect(none.res.status).toBe(403);
    const foreign = await connect({ Upgrade: "websocket", Origin: "https://evil.example" });
    expect(foreign.res.status).toBe(403);
    const same = await connect();
    expect(same.res.status).toBe(101);
    same.close();
  });
});

describe("service worker", () => {
  it("uses cache v26 and never caches /media or /verify", async () => {
    const sw = await (await call("/sw.js")).text();
    expect(sw).toContain('"kontak-v26"');
    expect(sw).toContain('url.pathname.startsWith("/media")');
    expect(sw).toContain('url.pathname.startsWith("/verify")');
  });
});
