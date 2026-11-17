import { z } from "zod";
import { profileSchema } from "./content.js";

export const deviceSchema = z.object({
  a1: z.string().min(1),
  webId: z.string().min(1),
  loadts: z.number(),
  sequence: z.number().int().nonnegative(),
  dsl: z.string(),
  dsUpdatedAt: z.number(),
  deviceTag: z.enum(["nop", "a3"]),
  webBuild: z.string(),
  userAgent: z.string(),
  b1: z.string(),
  ssk: z.string().optional(),
  activated: z.boolean(),
});
export type Device = z.infer<typeof deviceSchema>;
export const userSchema = z.object({
  id: z.string().min(1),
  nickname: z.string().nullable(),
  red_id: z.string().nullable(),
  bio: z.string().nullable(),
  avatar_url: z.string().nullable(),
  profile_url: z.string(),
  ref: profileSchema.shape.ref.optional(),
  counts: profileSchema.shape.counts.optional(),
  list_access: profileSchema.shape.list_access.optional(),
  is_self: z.literal(true),
  fetched_at: z.string(),
});
export type User = z.infer<typeof userSchema>;
export const sessionSchema = z.object({
  schema_version: z.literal(1),
  protocol_version: z.literal("pc-http-2026-11"),
  device: deviceSchema,
  cookies: z.record(z.string(), z.unknown()),
  user: userSchema.nullable(),
  authenticated: z.boolean(),
  login_pending: z.boolean().default(false),
  last_checked_at: z.string().nullable(),
  last_content_request_at: z.number().default(0),
});
export type Session = z.infer<typeof sessionSchema>;
export const challengeSchema = z.object({
  schema_version: z.literal(1),
  id: z.string().uuid(),
  method: z.enum(["sms", "qr"]),
  status: z.enum([
    "initializing",
    "sending",
    "awaiting_code",
    "awaiting_scan",
    "awaiting_confirmation",
    "authenticated",
    "expired",
    "cancelled",
    "failed",
  ]),
  created_at: z.string(),
  expires_at: z.string(),
  phone: z.string().optional(),
  zone: z.string().optional(),
  qr_id: z.string().optional(),
  qr_code: z.string().optional(),
  qr_text: z.string().optional(),
  session: sessionSchema.optional(),
  user: userSchema.optional(),
});
export type Challenge = z.infer<typeof challengeSchema>;
