import passport from 'passport';
import { Strategy as GoogleStrategy, type Profile } from 'passport-google-oauth20';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';

export type AuthedUser = { id: string };

async function upsertFromProfile(profile: Profile): Promise<AuthedUser> {
  const email = profile.emails?.find((e) => e.verified !== false)?.value ?? profile.emails?.[0]?.value;
  if (!email) throw new Error('Google profile has no email');
  const data = {
    email,
    name: profile.displayName || email.split('@')[0] || email,
    avatarUrl: profile.photos?.[0]?.value ?? null,
  };
  const user = await prisma.user.upsert({
    where: { googleId: profile.id },
    create: { googleId: profile.id, ...data },
    update: data,
    select: { id: true },
  });
  return user;
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
