import { z } from "zod";
import { userSchema, challengeSchema } from "../domain/models.js";
export const publicChallengeSchema = z.object({
  challenge_id: z.uuid(),
  method: challengeSchema.shape.method,
  status: challengeSchema.shape.status,
  created_at: z.string(),
  expires_at: z.string(),
  phone_masked: z.string().optional(),
  qr_text: z.string().optional(),
  user: userSchema.optional(),
});
