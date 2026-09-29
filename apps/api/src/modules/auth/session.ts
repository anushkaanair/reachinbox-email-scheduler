import type { CookieOptions, RequestHandler, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';

export const SESSION_COOKIE = 'ri_session';
export const OAUTH_STATE_COOKIE = 'ri_oauth_state';
const SESSION_TTL_SECONDS = 7 * 24 * 3600;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

export const cookieBase: CookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  secure: env.isProd,
  path: '/',
};

export function setSession(res: Response, userId: string): void {
  const token = jwt.sign({ sub: userId }, env.JWT_SECRET, { expiresIn: SESSION_TTL_SECONDS });
  res.cookie(SESSION_COOKIE, token, { ...cookieBase, maxAge: SESSION_TTL_SECONDS * 1000 });
}

export function clearSession(res: Response): void {
  res.clearCookie(SESSION_COOKIE, cookieBase);
}

function readUserId(token: string | undefined): string | null {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] });
    return typeof payload === 'object' && typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}

/** Rejects unauthenticated requests; sets `req.userId` for every downstream tenant-scoped query. */
export const requireAuth: RequestHandler = (req, _res, next) => {
  const userId = readUserId(req.cookies?.[SESSION_COOKIE]);
  if (!userId) return next(AppError.unauthenticated());
  req.userId = userId;
  next();
};

/** Operator-only surfaces (Bull Board can retry/delete any tenant's jobs). */
export const requireAdmin: RequestHandler = async (req, _res, next) => {
  if (env.adminEmails.length === 0) return next(); // dev default: any signed-in user
  try {
    const user = await prisma.user.findUnique({ where: { id: authedUserId(req) }, select: { email: true } });
    if (user && env.adminEmails.includes(user.email.toLowerCase())) return next();
    next(new AppError(403, 'FORBIDDEN', 'Admins only'));
  } catch (err) {
    next(err);
  }
};

/** Narrowing helper for handlers mounted behind `requireAuth`. */
export function authedUserId(req: { userId?: string }): string {
  if (!req.userId) throw AppError.unauthenticated();
  return req.userId;
}
