import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { connect, register, newPhone } from "./helpers.js";

async function legacyHash(password, salt) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(salt + password));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("auth", () => {
  it("registers with an 8+ character password and logs back in", async () => {
    const a = await register("Alice Test");
    expect(a.user.phone).toBe(a.phone);
    expect(a.token).toMatch(/^[0-9a-f]{64}$/);
    a.close();

    const b = await connect();
    const ok = await b.request({ type: "login", phone: a.phone, password: "motdepasse123" }, "auth-ok");
    expect(ok.type).toBe("auth-ok");
    expect(ok.user.id).toBe(a.user.id);

    const r = await connect();
    const resumed = await r.request({ type: "resume", token: ok.token }, "auth-ok");
    expect(resumed.type).toBe("auth-ok");
    b.close(); r.close();
  });

  it("refuses new accounts with short passwords", async () => {
    const c = await connect();
    const res = await c.request({ type: "register", name: "Short", phone: newPhone(), password: "1234" }, "auth-ok");
    expect(res).toEqual({ type: "error", error: "Modpas omwen 8 karaktè" });
    c.close();
  });

  it("rejects wrong passwords", async () => {
    const a = await register("Bob Test");
    const c = await connect();
    const res = await c.request({ type: "login", phone: a.phone, password: "wrong-password" }, "auth-ok");
    expect(res).toEqual({ type: "error", error: "bad-creds" });
    a.close(); c.close();
  });

  it("lets legacy accounts (short password, SHA-256 hash) log in and upgrades the hash", async () => {
    const phone = newPhone();
    const salt = "legacysalt";
    await env.DB.prepare("INSERT INTO users (name, phone, salt, hash, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind("Legacy", phone, salt, await legacyHash("1234", salt), Date.now()).run();
    const c = await connect();
    const res = await c.request({ type: "login", phone, password: "1234" }, "auth-ok");
    expect(res.type).toBe("auth-ok");
    const row = await env.DB.prepare("SELECT hash FROM users WHERE phone = ?").bind(phone).first();
    expect(row.hash.startsWith("pbkdf2:")).toBe(true);
    c.close();

    const again = await connect();
    expect((await again.request({ type: "login", phone, password: "1234" }, "auth-ok")).type).toBe("auth-ok");
    again.close();
  });

  it("validates every message with a schema", async () => {
    const c = await connect();
    expect(await c.request({ type: "nope" }, "x")).toEqual({ type: "error", error: "unknown-type" });
    expect(await c.request({ type: "login", phone: 123, password: "x" }, "x")).toEqual({ type: "error", error: "bad-input" });
    const a = await register("Validator");
    expect(await a.request({ type: "sendMessage", convId: "abc", body: "hi" }, "x")).toEqual({ type: "error", error: "bad-input" });
    expect(await a.request({ type: "getPhoto", id: { $gt: 0 } }, "x")).toEqual({ type: "error", error: "bad-input" });
    c.close(); a.close();
  });
});

describe("messages", () => {
  it("delivers a message from A to B over WebSocket", async () => {
    const a = await register("Sender");
    const b = await register("Receiver");
    const conv = await a.request({ type: "getOrCreateConversation", peerId: b.user.id }, "conversation");
    expect(conv.type).toBe("conversation");

    a.send({ type: "sendMessage", convId: conv.id, body: "Bonjou!", clientId: "c1" });
    const ack = await a.next("message-ack");
    expect(ack.clientId).toBe("c1");
    const got = await b.next("new-message");
    expect(got.message.body).toBe("Bonjou!");
    expect(got.message.from).toBe(a.user.id);

    // duplicate clientId is acknowledged but not stored twice
    a.send({ type: "sendMessage", convId: conv.id, body: "Bonjou!", clientId: "c1" });
    expect((await a.next("message-ack")).id).toBe(ack.id);

    const hist = await b.request({ type: "getMessages", convId: conv.id }, "messages");
    expect(hist.messages.map((m) => m.body)).toEqual(["Bonjou!"]);

    // a stranger cannot read the conversation
    const s = await register("Stranger");
    expect(await s.request({ type: "getMessages", convId: conv.id }, "messages")).toEqual({ type: "error", error: "no-conv" });
    a.close(); b.close(); s.close();
  });
});

describe("privacy", () => {
  it("search by name masks phone numbers and partial digits find nothing", async () => {
    const target = await register("Zanmi Prive");
    const me = await register("Searcher");

    const byName = await me.request({ type: "search", q: "zanmi" }, "search-results");
    const hit = byName.results.find((u) => u.id === target.user.id);
    expect(hit).toBeTruthy();
    expect(hit.phone).not.toBe(target.phone);
    expect(hit.phone).toContain("•");
    expect(JSON.stringify(byName)).not.toContain(target.phone);

    const partial = await me.request({ type: "search", q: target.phone.slice(0, 6) }, "search-results");
    expect(partial.results).toEqual([]);

    const exact = await me.request({ type: "search", q: target.phone }, "search-results");
    expect(exact.results.map((u) => [u.id, u.phone])).toEqual([[target.user.id, target.phone]]);
    target.close(); me.close();
  });

  it("contact matching still returns known numbers", async () => {
    const target = await register("Contact Match");
    const me = await register("Matcher");
    const res = await me.request({ type: "matchContacts", phones: [target.phone, "50900000000"] }, "contacts");
    expect(res.list.map((u) => [u.id, u.phone])).toEqual([[target.user.id, target.phone]]);
    target.close(); me.close();
  });

  it("getPhoto is limited to people you share a conversation with or found", async () => {
    const owner = await register("Photo Owner");
    const photo = "data:image/png;base64,AAAA";
    await owner.request({ type: "setProfile", photo }, "profile-ok");

    const stranger = await register("Stranger Photo");
    expect(await stranger.request({ type: "getPhoto", id: owner.user.id }, "photo")).toEqual({ type: "photo", id: owner.user.id, photo: "" });

    const friend = await register("Friend Photo");
    await friend.request({ type: "getOrCreateConversation", peerId: owner.user.id }, "conversation");
    expect((await friend.request({ type: "getPhoto", id: owner.user.id }, "photo")).photo).toBe(photo);

    // found through search -> allowed
    await stranger.request({ type: "search", q: "photo owner" }, "search-results");
    expect((await stranger.request({ type: "getPhoto", id: owner.user.id }, "photo")).photo).toBe(photo);
    owner.close(); stranger.close(); friend.close();
  });

  it("conversation list shows the full number only once the peer has written", async () => {
    const a = await register("Peer A");
    const b = await register("Peer B");
    const conv = await a.request({ type: "getOrCreateConversation", peerId: b.user.id }, "conversation");
    expect(conv.peer.phone).not.toBe(b.phone);
    b.send({ type: "sendMessage", convId: conv.id, body: "alo" });
    await a.next("new-message");
    const list = await a.request({ type: "getConversations" }, "conversations");
    expect(list.list.find((c) => c.id === conv.id).peer.phone).toBe(b.phone);
    a.close(); b.close();
  });
});

describe("calls", () => {
  it("relays offer / answer / hangup between the two peers", async () => {
    const a = await register("Caller");
    const b = await register("Callee");
    const conv = await a.request({ type: "getOrCreateConversation", peerId: b.user.id }, "conversation");
    a.send({ type: "callOffer", convId: conv.id, offer: { type: "offer", sdp: "v=0" }, audioOnly: true });
    const state = await a.next("call-state");
    const offer = await b.next("callOffer");
    expect(offer.from).toBe(a.user.id);
    expect(offer.callId).toBe(state.callId);
    expect(offer.offer.sdp).toBe("v=0");

    b.send({ type: "callAnswer", convId: conv.id, callId: offer.callId, answer: { type: "answer", sdp: "v=0" } });
    expect((await a.next("callAnswer")).answer.type).toBe("answer");
    b.send({ type: "callIce", convId: conv.id, callId: offer.callId, candidate: { candidate: "candidate:1" } });
    expect((await a.next("callIce")).candidate.candidate).toBe("candidate:1");
    a.send({ type: "callHangup", convId: conv.id, callId: offer.callId });
    await b.next("callHangup");

    const calls = await b.request({ type: "getCalls" }, "calls");
    expect(calls.list[0]).toMatchObject({ peerId: a.user.id, kind: "audio", status: "in" });
    a.close(); b.close();
  });
});
