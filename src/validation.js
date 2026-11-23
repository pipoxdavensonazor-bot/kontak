import { z } from "zod";

// Every incoming WebSocket message is parsed by one of these schemas before it
// reaches a handler. Ids are coerced from strings so older clients keep working.

export const PASSWORD_MIN = 8;

const digits = (s) => String(s ?? "").replace(/\D/g, "");

const phone = z
  .string()
  .max(40)
  .transform(digits)
  .pipe(z.string().min(8, "Nimewo twò kout (8-15 chif)").max(15, "Nimewo twò long"));

const id = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const optId = z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullish();
const callId = z.string().max(80).nullish();
const opaque = z.looseObject({}).nullish();

export const RegisterSchema = z.object({
  type: z.literal("register"),
  name: z.string().trim().min(1, "Non obligatwa").max(40),
  phone,
  password: z.string().min(PASSWORD_MIN, `Modpas omwen ${PASSWORD_MIN} karaktè`).max(100),
});

// Existing accounts may still have shorter passwords: login only needs a non-empty one.
export const LoginSchema = z.object({
  type: z.literal("login"),
  phone,
  password: z.string().min(1, "bad-creds").max(100),
});

export const SearchSchema = z.object({
  type: z.literal("search"),
  q: z.string().max(100).optional(),
});

export const SendMessageSchema = z.object({
  type: z.literal("sendMessage"),
  convId: id,
  body: z.string().max(2000).nullish(),
  clientId: z.string().max(80).nullish(),
  // v24: voice note / photo previously uploaded with POST /media
  mediaId: z.string().regex(/^[a-f0-9]{32}$/).nullish(),
});

export const GetMessagesSchema = z.object({
  type: z.literal("getMessages"),
  convId: id,
  beforeId: z.coerce.number().nonnegative().nullish(),
  limit: z.coerce.number().int().min(1).max(50).nullish(),
});

export const GetOrCreateSchema = z.object({
  type: z.literal("getOrCreateConversation"),
  peerId: id,
});

const bare = (type) => z.object({ type: z.literal(type) });

// Call / mesh signalling is relayed to the peer, so unknown fields are kept (looseObject),
// but the routing fields are typed.
const relay = (type) =>
  z.looseObject({
    type: z.literal(type),
    peerId: optId,
    convId: optId,
    callId,
    to: optId,
    audioOnly: z.boolean().nullish(),
    offer: opaque,
    answer: opaque,
    candidate: opaque,
  });

const SCHEMAS = {
  register: RegisterSchema,
  login: LoginSchema,
  resume: z.object({ type: z.literal("resume"), token: z.string().min(1, "bad-creds").max(200) }),
  logout: bare("logout"),
  search: SearchSchema,
  getConversations: bare("getConversations"),
  getOrCreateConversation: GetOrCreateSchema,
  dial: z.object({ type: z.literal("dial"), phone: z.string().max(40) }),
  getMessages: GetMessagesSchema,
  sendMessage: SendMessageSchema,
  setProfile: z.object({
    type: z.literal("setProfile"),
    name: z.string().max(200).nullish(),
    photo: z.string().max(14000, "photo-big").nullish(),
  }),
  createGroup: z.object({
    type: z.literal("createGroup"),
    title: z.string().max(200).nullish(),
    phones: z.union([z.string().max(2000), z.array(z.union([z.string().max(40), z.number()])).max(50)]),
  }),
  getPhoto: z.object({ type: z.literal("getPhoto"), id }),
  markRead: z.object({ type: z.literal("markRead"), convId: id }),
  pushSubscribe: z.object({
    type: z.literal("pushSubscribe"),
    subscription: z.looseObject({
      endpoint: z.string().max(800).startsWith("https://"),
      keys: z.looseObject({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }),
    }),
    previous: z.string().max(800).nullish(),
  }),
  getCalls: bare("getCalls"),
  matchContacts: z.object({
    type: z.literal("matchContacts"),
    phones: z.array(z.union([z.string().max(40), z.number()])).max(200),
  }),
  callAdd: z.object({
    type: z.literal("callAdd"),
    to: id,
    convId: optId,
    with: z.array(z.coerce.number().int()).max(16).nullish(),
  }),
  dismissCall: bare("dismissCall"),
  replayCall: bare("replayCall"),
  typing: z.object({ type: z.literal("typing"), convId: id }),
  meshOffer: relay("meshOffer"),
  meshAnswer: relay("meshAnswer"),
  meshIce: relay("meshIce"),
  callOffer: relay("callOffer"),
  callAnswer: relay("callAnswer"),
  callIce: relay("callIce"),
  callDecline: relay("callDecline"),
  callHangup: relay("callHangup"),
};

export const MESSAGE_TYPES = Object.keys(SCHEMAS);

export function validate(schema, data) {
  const result = schema.safeParse(data);
  if (!result.success) {
    const msg = result.error.issues.map((i) => i.message).join(", ");
    throw new Error(msg || "validation-error");
  }
  return result.data;
}

// Returns the parsed message, or throws Error("unknown-type") / Error(<zod message>).
export function parseIncoming(msg) {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) throw new Error("bad-json");
  const schema = Object.hasOwn(SCHEMAS, msg.type) ? SCHEMAS[msg.type] : null;
  if (!schema) throw new Error("unknown-type");
  const result = schema.safeParse(msg);
  if (!result.success) {
    const first = result.error.issues[0];
    const text = first && first.message;
    const generic = !text || /^(Invalid|Too (small|big)|Expected|Unrecognized)/i.test(text);
    throw new Error(generic ? "bad-input" : text);
  }
  return result.data;
}
