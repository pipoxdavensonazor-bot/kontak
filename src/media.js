// Voice notes and photos: bytes in R2 (env.MEDIA), metadata in D1 `media`.
// Upload:   POST /media?convId=N&kind=voice|photo&duration=ms  (Authorization: Bearer <session>)
// Download: GET  /media/<id>                                    (Authorization: Bearer <session>)
// Only members of the conversation can upload to it or read from it. Ids are 128-bit random.

export const MEDIA_LIMITS = {
  voice: { maxBytes: 1_500_000, maxDurationMs: 125_000, types: ["audio/webm", "audio/ogg", "audio/mp4", "audio/aac", "audio/mpeg"] },
  photo: { maxBytes: 1_500_000, maxDurationMs: 0, types: ["image/jpeg", "image/webp", "image/png"] }
};

export const MEDIA_ID = /^[a-f0-9]{32}$/;

export function mediaLabel(kind, durationMs) {
  if (kind === "voice") {
    const s = Math.max(1, Math.round((Number(durationMs) || 0) / 1000));
    return "🎤 Not vokal (" + Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0") + ")";
  }
  return "📷 Foto";
}

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sessionUser(request, env) {
  const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token || token.length > 200) return null;
  const row = await env.DB.prepare(
    "SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > ?"
  ).bind(await sha256(token), Date.now()).first();
  return row ? Number(row.user_id) : null;
}

export async function isMember(env, convId, userId) {
  const row = await env.DB.prepare(
    "SELECT 1 AS ok FROM conversations c WHERE c.id = ? AND (" +
    "(COALESCE(c.is_group, 0) = 0 AND (c.user_a = ? OR c.user_b = ?)) OR " +
    "(c.is_group = 1 AND (c.user_a = ? OR EXISTS (SELECT 1 FROM members m WHERE m.conv_id = c.id AND m.user_id = ?))))"
  ).bind(convId, userId, userId, userId, userId).first();
  return !!row;
}

const json = (body, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

function randomId() {
  return [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function handleMedia(request, env, url) {
  if (!env.MEDIA) return json({ error: "media-off" }, 503);
  const userId = await sessionUser(request, env);
  if (!userId) return json({ error: "auth" }, 401);

  if (url.pathname === "/media" && request.method === "POST") {
    const convId = Number(url.searchParams.get("convId"));
    const kind = url.searchParams.get("kind");
    const limits = MEDIA_LIMITS[kind];
    if (!Number.isInteger(convId) || convId <= 0 || !limits) return json({ error: "bad-input" }, 400);
    const mime = String(request.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
    if (!limits.types.includes(mime)) return json({ error: "bad-type" }, 415);
    const declared = Number(request.headers.get("Content-Length") || 0);
    if (declared > limits.maxBytes) return json({ error: "too-big" }, 413);
    let durationMs = Math.round(Number(url.searchParams.get("duration")) || 0);
    if (kind === "voice") {
      if (durationMs <= 0) durationMs = 1000;
      if (durationMs > limits.maxDurationMs) return json({ error: "too-long" }, 413);
    } else durationMs = 0;
    if (!(await isMember(env, convId, userId))) return json({ error: "no-conv" }, 403);

    const bytes = await request.arrayBuffer();
    if (!bytes.byteLength) return json({ error: "empty" }, 400);
    if (bytes.byteLength > limits.maxBytes) return json({ error: "too-big" }, 413);

    const id = randomId();
    const key = "c" + convId + "/" + id;
    await env.MEDIA.put(key, bytes, { httpMetadata: { contentType: mime } });
    await env.DB.prepare(
      "INSERT INTO media (id, conv_id, owner_id, message_id, kind, mime, size, duration_ms, r2_key, created_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)"
    ).bind(id, convId, userId, kind, mime, bytes.byteLength, durationMs, key, Date.now()).run();
    return json({ id, kind, mime, size: bytes.byteLength, durationMs }, 201);
  }

  const m = url.pathname.match(/^\/media\/([a-f0-9]{32})$/);
  if (m && (request.method === "GET" || request.method === "HEAD")) {
    const row = await env.DB.prepare("SELECT * FROM media WHERE id = ?").bind(m[1]).first();
    // Same answer for "missing" and "not yours" so ids cannot be probed.
    if (!row || !(await isMember(env, Number(row.conv_id), userId))) return json({ error: "not-found" }, 404);
    const obj = await env.MEDIA.get(row.r2_key);
    if (!obj) return json({ error: "not-found" }, 404);
    return new Response(request.method === "HEAD" ? null : obj.body, {
      headers: {
        "Content-Type": row.mime,
        "Content-Length": String(row.size),
        "Cache-Control": "private, max-age=604800, immutable",
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": "inline"
      }
    });
  }
  return json({ error: "not-found" }, 404);
}
