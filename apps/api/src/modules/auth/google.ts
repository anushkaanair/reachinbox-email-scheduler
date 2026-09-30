import passport from 'passport';
import { Strategy as GoogleStrategy, type Profile } from 'passport-google-oauth20';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';

export type AuthedUser = { id: string };

export async function upsertFromProfile(profile: Profile): Promise<AuthedUser> {
  const email = profile.emails?.find((e) => e.verified !== false)?.value ?? profile.emails?.[0]?.value;
  if (!email) throw new Error('Google profile has no email');
  const data = {
    email,
    name: profile.displayName || email.split('@')[0] || email,
    avatarUrl: profile.photos?.[0]?.value ?? null,
  };
  const byGoogle = await prisma.user.findUnique({ where: { googleId: profile.id }, select: { id: true } });
  if (byGoogle) {
    await prisma.user.update({ where: { id: byGoogle.id }, data });
    return byGoogle;
  }
  // Same address, registered earlier with a password. Google has verified this email, the password sign-up
  // never did, so link the accounts and drop the password: otherwise whoever pre-registered the address
  // (and knows that password) would keep access to the real owner's account.
  const byEmail = await prisma.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } }, select: { id: true } });
  if (byEmail) {
    await prisma.user.update({ where: { id: byEmail.id }, data: { ...data, googleId: profile.id, passwordHash: null } });
    return byEmail;
  }
  return prisma.user.create({ data: { googleId: profile.id, ...data }, select: { id: true } });
}

export function configureGoogle(): void {
  if (!env.googleConfigured) {
    logger.warn('Google OAuth not configured — set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET');
    return;
  }
  passport.use(
    new GoogleStrategy(
      {
        clientID: env.GOOGLE_CLIENT_ID!,
        clientSecret: env.GOOGLE_CLIENT_SECRET!,
        callbackURL: env.GOOGLE_CALLBACK_URL,
      },
      (_accessToken, _refreshToken, profile, done) => {
        upsertFromProfile(profile).then(
          (user) => done(null, user),
          (err: Error) => done(err),
        );
      },
    ),
  );
}
