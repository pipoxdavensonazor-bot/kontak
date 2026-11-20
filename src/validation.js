import { z } from "zod";

const phone = z
  .string()
  .transform((s) => String(s || "").replace(/\D/g, ""))
  .pipe(z.string().min(8, "Nimewo twò kout (8-15 chif)").max(15, "Nimewo twò long"));

export const RegisterSchema = z.object({
  type: z.literal("register"),
  name: z.string().trim().min(1, "Non obligatwa").max(40),
  phone,
  password: z.string().min(4, "Modpas omwen 4 karaktè").max(100),
});

export const LoginSchema = z.object({
  type: z.literal("login"),
  phone,
  password: z.string().min(4, "Modpas omwen 4 karaktè").max(100),
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

export function validate(schema, data) {
  const result = schema.safeParse(data);
  if (!result.success) {
    const msg = result.error.issues.map((i) => i.message).join(", ");
    throw new Error(msg || "validation-error");
  }
  return result.data;
}
