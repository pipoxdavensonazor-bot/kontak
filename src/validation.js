import { z } from "zod";

export const RegisterSchema = z.object({
  type: z.literal("register"),
  name: z.string().min(1).max(40),
  phone: z.string().min(6).max(20),
  password: z.string().min(4).max(100),
});

export const LoginSchema = z.object({
  type: z.literal("login"),
  phone: z.string().min(6).max(20),
  password: z.string().min(4).max(100),
});

export const SearchSchema = z.object({
  type: z.literal("search"),
  q: z.string().max(100).optional(),
});

export const SendMessageSchema = z.object({
  type: z.literal("sendMessage"),
  convId: z.number().int().positive(),
  body: z.string().min(1).max(2000),
});

export const GetMessagesSchema = z.object({
  type: z.literal("getMessages"),
  convId: z.number().int().positive(),
  beforeId: z.number().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

export const GetOrCreateSchema = z.object({
  type: z.literal("getOrCreateConversation"),
  peerId: z.number().int().positive(),
});

export const CallSchema = z.object({
  type: z.enum(["callOffer", "callAnswer", "callIce", "callDecline", "callHangup"]),
  convId: z.number().int().positive().optional(),
  peerId: z.number().int().positive().optional(),
  sdp: z.string().optional(),
  candidate: z.string().optional(),
  audioOnly: z.boolean().optional(),
});

export function validate(schema, data) {
  const result = schema.safeParse(data);
  if (!result.success) {
    const msg = result.error.issues.map(i => i.message).join(", ");
    throw new Error(msg || "validation-error");
  }
  return result.data;
}
