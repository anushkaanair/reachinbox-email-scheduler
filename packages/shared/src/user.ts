import { z } from 'zod';

export const UserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
  avatarUrl: z.string().nullable(),
  slackConnected: z.boolean(),
});
export type User = z.infer<typeof UserSchema>;

export const SenderSchema = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string(),
  isActive: z.boolean(),
  hourlyLimit: z.number(),
  usedThisWindow: z.number(),
});
export type Sender = z.infer<typeof SenderSchema>;
