import { z } from 'zod';

/** Email + password sign-in. Google sign-in stays the primary path; both end in the same session cookie. */
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;

const email = z.string().trim().toLowerCase().email('Enter a valid email address').max(320);

export const SignupSchema = z.object({
  email,
  password: z.string().min(PASSWORD_MIN, `Use at least ${PASSWORD_MIN} characters`).max(PASSWORD_MAX, `Use at most ${PASSWORD_MAX} characters`),
  name: z.string().trim().min(1).max(80).optional(),
});
export type Signup = z.infer<typeof SignupSchema>;

/** Login never reveals *why* it failed, so it only checks the shape, not the password policy. */
export const LoginSchema = z.object({
  email,
  password: z.string().min(1, 'Enter your password').max(PASSWORD_MAX),
});
export type Login = z.infer<typeof LoginSchema>;
