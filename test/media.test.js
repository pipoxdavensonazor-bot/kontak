import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { call, register, connect } from "./helpers.js";

const OPUS = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4, 5, 6, 7, 8]);

function upload(token, convId, { kind = "voice", type = "audio/webm", body = OPUS, duration = 3200 } = {}) {
  return call(`/media?convId=${convId}&kind=${kind}&duration=${duration}`, {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": type },
    body
  });
}
const download = (token, id) => call("/media/" + id, { headers: token ? { Authorization: "Bearer " + token } : {} });

async function pair() {
  const a = await register("Voice A");
  const b = await register("Voice B");
  const conv = await a.request({ type: "getOrCreateConversation", peerId: b.user.id }, "conversation");
  return { a, b, convId: conv.id };
}

describe("voice notes and photos", () => {
  it("uploads a voice note, sends it, the peer receives and downloads it; strangers cannot", async () => {
    const { a, b, convId } = await pair();
    const res = await upload(a.token, convId);
    expect(res.status).toBe(201);
    const up = await res.json();
    expect(up).toMatchObject({ kind: "voice", mime: "audio/webm", size: OPUS.length, durationMs: 3200 });
    expect(up.id).toMatch(/^[a-f0-9]{32}$/);

    a.send({ type: "sendMessage", convId, mediaId: up.id, clientId: "v1" });
    await a.next("message-ack");
    const got = await b.next("new-message");
    expect(got.message.kind).toBe("voice");
    expect(got.message.media).toEqual({ id: up.id, kind: "voice", mime: "audio/webm", size: OPUS.length, durationMs: 3200 });
    // old clients (v23) only read body: readable fallback text
    expect(got.message.body).toBe("🎤 Not vokal (0:03)");

    const dl = await download(b.token, up.id);
    expect(dl.status).toBe(200);
    expect(dl.headers.get("Content-Type")).toBe("audio/webm");
    expect(dl.headers.get("Cache-Control")).toContain("private");
    expect(new Uint8Array(await dl.arrayBuffer())).toEqual(OPUS);

    const s = await register("Voice Stranger");
    expect((await download(s.token, up.id)).status).toBe(404);
    expect((await download(null, up.id)).status).toBe(401);
    expect((await download(b.token, "0".repeat(32))).status).toBe(404);

    // history carries the media too
    const hist = await b.request({ type: "getMessages", convId }, "messages");
    expect(hist.messages.at(-1).media.id).toBe(up.id);

    // re-sending the same media (outbox retry) does not duplicate the message
    a.send({ type: "sendMessage", convId, mediaId: up.id, clientId: "v1-retry" });
    expect((await a.next("message-ack")).id).toBe(got.message.id);
    a.close(); b.close(); s.close();
  });

  it("refuses uploads from non-members, bad types, oversize and too-long notes", async () => {
    const { a, b, convId } = await pair();
    const s = await register("Upload Stranger");
    expect((await upload(s.token, convId)).status).toBe(403);
    expect((await upload("nope", convId)).status).toBe(401);
    expect((await upload(a.token, convId, { type: "text/html" })).status).toBe(415);
    expect((await upload(a.token, convId, { kind: "video" })).status).toBe(400);
    expect((await upload(a.token, convId, { duration: 600000 })).status).toBe(413);
    expect((await upload(a.token, convId, { body: new Uint8Array(1_600_000) })).status).toBe(413);
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM media WHERE conv_id = ?").bind(convId).first();
    expect(rows.n).toBe(0);
    a.close(); b.close(); s.close();
  });

  it("a stranger cannot attach someone else's media to a message", async () => {
    const { a, b, convId } = await pair();
    const up = await (await upload(a.token, convId)).json();
    const res = await b.request({ type: "sendMessage", convId, mediaId: up.id }, "message-ack");
    expect(res).toEqual({ type: "error", error: "no-media" });
    const bad = await b.request({ type: "sendMessage", convId, mediaId: "../etc" }, "message-ack");
    expect(bad).toEqual({ type: "error", error: "bad-input" });
    const empty = await b.request({ type: "sendMessage", convId }, "message-ack");
    expect(empty).toEqual({ type: "error", error: "empty" });
    a.close(); b.close();
  });

  it("photos work in groups for every member", async () => {
    const a = await register("Group A");
    const b = await register("Group B");
    const c = await register("Group C");
    a.send({ type: "createGroup", title: "Fanmi", phones: [b.phone, c.phone] });
    const g = await a.next("conversation");
    const up = await (await upload(a.token, g.id, { kind: "photo", type: "image/jpeg", body: new Uint8Array([0xff, 0xd8, 0xff, 1]), duration: 0 })).json();
    a.send({ type: "sendMessage", convId: g.id, mediaId: up.id });
    const got = await c.next("new-message");
    expect(got.message.media.kind).toBe("photo");
    expect(got.message.body).toBe("📷 Foto");
    expect((await download(b.token, up.id)).status).toBe(200);
    expect((await download(c.token, up.id)).status).toBe(200);
    const s = await connect();
    s.close();
    a.close(); b.close(); c.close();
  });
});
