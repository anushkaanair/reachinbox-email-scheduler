import { AlertCircle, CalendarClock, Gauge, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { GOOGLE_LOGIN_URL } from '@/api/auth';
import { Logo } from '@/components/layout/Logo';
import { Spinner } from '@/components/ui/Spinner';
import { useAuth } from '@/hooks/useAuth';

const ERRORS: Record<string, string> = {
  not_configured: 'Google login is not configured on the server yet (GOOGLE_CLIENT_ID / SECRET).',
  state_mismatch: 'Your login session expired. Please try again.',
  oauth_failed: 'Google sign-in failed or was cancelled. Please try again.',
};

function GoogleIcon() {
  return (
    <svg viewBox="0 0 48 48" className="size-5" aria-hidden>
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}

const HIGHLIGHTS = [
  { icon: CalendarClock, text: 'Schedule thousands of emails with exact start times' },
  { icon: Gauge, text: 'Per-sender throttling & hourly limits, safe across workers' },
  { icon: ShieldCheck, text: 'Restart-safe and idempotent — never sent twice' },
];

export function LoginPage() {
  const { user, isLoading } = useAuth();
  const [params] = useSearchParams();
  const [redirecting, setRedirecting] = useState(false);
  const errorKey = params.get('error');

  if (!isLoading && user) return <Navigate to="/dashboard" replace />;

  return (
    <div className="grid min-h-full lg:grid-cols-2">
      <section className="flex flex-col justify-center px-6 py-12 sm:px-12">
        <div className="mx-auto w-full max-w-sm">
          <Logo className="mb-10" />
          <h1 className="text-3xl font-bold tracking-tight">Welcome back</h1>
          <p className="mt-2 text-sm text-muted">Sign in to schedule and track your outreach.</p>

          {errorKey && (
            <div role="alert" className="mt-6 flex gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              {ERRORS[errorKey] ?? 'Sign-in failed. Please try again.'}
            </div>
          )}

          <a
            href={GOOGLE_LOGIN_URL}
            onClick={() => setRedirecting(true)}
            aria-busy={redirecting}
            className="mt-8 flex h-12 w-full items-center justify-center gap-3 rounded-lg border border-line bg-surface text-sm font-semibold text-ink shadow-sm transition-colors hover:bg-canvas"
          >
            {redirecting ? <Spinner className="size-5" /> : <GoogleIcon />}
            Login with Google
          </a>
          <p className="mt-4 text-center text-xs text-muted">
            We only read your name, email and profile photo.
          </p>
        </div>
      </section>

      <section className="hidden flex-col justify-center bg-brand-700 px-12 text-white lg:flex">
        <div className="max-w-md">
          <h2 className="text-3xl font-bold leading-tight">Cold outreach that actually reaches the inbox.</h2>
          <ul className="mt-8 space-y-4">
            {HIGHLIGHTS.map(({ icon: Icon, text }) => (
              <li key={text} className="flex items-start gap-3 text-white/90">
                <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-white/15">
                  <Icon className="size-4" />
                </span>
                <span className="pt-1 text-sm">{text}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </div>
  );
}
