import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import worker, { iceServersFor } from "../src/worker.js";
import { call, connect, register, ORIGIN } from "./helpers.js";

describe("HTTP endpoints", () => {
  it("serves the app shell with build v28", async () => {
    const res = await call("/");
    expect(res.status).toBe(200);
    const app = await (await call("/app.js")).text();
    expect(app).toContain('BUILD = "v28"');
    expect(app).toContain('console.info("Kontak"');
    expect(app).not.toContain('" · " + BUILD');
  });

  it("exposes the build on /version only, not in the UI", async () => {
    const res = await call("/version");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ build: "v28" });
    const html = await (await call("/")).text();
    expect(html).not.toContain("Dekonekte");
    expect(html).not.toContain(" · v28");
    expect(html).not.toContain("BUILD");
    expect(html).not.toContain("Mòd SAT");
    expect(html).not.toContain("Mode SAT");
    expect(html).not.toContain("turnBtn");
    expect(html).not.toContain("TURN (coturn)");
    expect(html).not.toContain('class="pills"');
    expect(html).toContain('id="menuBtn"');
    expect(html).toContain('id="connBar"');
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
  it("uses cache v28 and never caches /media or /verify", async () => {
    const sw = await (await call("/sw.js")).text();
    expect(sw).toContain('"kontak-v28"');
    expect(sw).toContain('url.pathname.startsWith("/media")');
    expect(sw).toContain('url.pathname.startsWith("/verify")');
  });

  it("precaches the brand icons", async () => {
    const sw = await (await call("/sw.js")).text();
    for (const path of ["/favicon.svg", "/favicon.ico", "/favicon-32.png", "/apple-touch-icon.png", "/icon-192.png", "/icon-512.png", "/maskable-512.png", "/logo.svg"]) {
      expect(sw).toContain(path);
    }
  });
});

describe("brand icons", () => {
  it("serves favicon.svg, favicon.ico and the png set", async () => {
    const svg = await call("/favicon.svg");
    expect(svg.status).toBe(200);
    expect(svg.headers.get("content-type") || "").toMatch(/svg/);
    const body = await svg.text();
    expect(body).toContain("#0C1C36");
    expect(body).toContain("#1EBB62");

    const ico = await call("/favicon.ico");
    expect(ico.status).toBe(200);
    expect((await ico.arrayBuffer()).byteLength).toBeGreaterThan(16);

    for (const path of ["/favicon-32.png", "/apple-touch-icon.png", "/icon-192.png", "/icon-512.png", "/maskable-512.png", "/logo.svg"]) {
      const res = await call(path);
      expect(res.status, path).toBe(200);
      expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(16);
    }
  });

  it("links svg and ico favicons plus the apple touch icon", async () => {
    const html = await (await call("/")).text();
    expect(html).toContain('rel="icon" href="favicon.svg"');
    expect(html).toContain('rel="icon" href="favicon.ico"');
    expect(html).toContain('rel="apple-touch-icon" href="apple-touch-icon.png"');
    expect(html).toContain('theme-color" content="#0C1C36"');
    expect(html).toContain('class="brand-mark" src="logo.svg"');
  });

  it("lists separate any and maskable icons in the manifest", async () => {
    const res = await call("/manifest.json");
    expect(res.status).toBe(200);
    const manifest = await res.json();
    expect(manifest.theme_color).toBe("#0C1C36");
    const byPurpose = Object.fromEntries(manifest.icons.map((i) => [i.purpose, i.src]));
    expect(byPurpose.any).toBeDefined();
    expect(byPurpose.maskable).toBe("maskable-512.png");
    expect(manifest.icons.some((i) => i.src === "icon-192.png" && i.purpose === "any")).toBe(true);
    expect(manifest.icons.some((i) => i.src === "icon-512.png" && i.purpose === "any")).toBe(true);
    expect(manifest.icons.every((i) => i.purpose !== "any maskable")).toBe(true);
  });
});
