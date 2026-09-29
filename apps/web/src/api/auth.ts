import { UserSchema, type User } from '@ri/shared';
import { ApiError, api } from './client';

/** Returns null when signed out, instead of throwing — "not logged in" is a normal state. */
export async function fetchMe(): Promise<User | null> {
  try {
    return await api('/auth/me', { schema: UserSchema });
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}

export const logout = () => api('/auth/logout', { method: 'POST' });

/** Full-page navigation: OAuth needs real redirects, not XHR. */
export const GOOGLE_LOGIN_URL = '/api/auth/google';
