import { AlertCircle } from 'lucide-react';
import { useState } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { PASSWORD_MIN } from '@ri/shared';
import { GOOGLE_LOGIN_URL } from '@/api/auth';
import { Spinner } from '@/components/ui/Spinner';
import { useAuth, usePasswordAuth } from '@/hooks/useAuth';

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

const field =
  'h-14 w-full rounded-xl bg-neutral-soft px-5 text-[15px] text-ink placeholder:text-muted focus:bg-surface focus:ring-2 focus:ring-brand-600/40 focus:outline-none aria-[invalid=true]:ring-2 aria-[invalid=true]:ring-danger-solid/50';

/** The Figma login card: Google first, then email + password. The same form creates an account via the link underneath. */
export function LoginPage() {
  const { user, isLoading } = useAuth();
  const [params] = useSearchParams();
  const [redirecting, setRedirecting] = useState(false);
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [touched, setTouched] = useState(false);
  const auth = usePasswordAuth(mode);
  const errorKey = params.get('error');

  if (!isLoading && user) return <Navigate to="/dashboard" replace />;

  const emailBad = touched && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const passBad = touched && (mode === 'signup' ? password.length < PASSWORD_MIN : password.length === 0);
  const serverError = auth.error?.message ?? (errorKey ? (ERRORS[errorKey] ?? 'Sign-in failed. Please try again.') : null);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (emailBad || passBad || !email.trim() || !password) return;
    auth.mutate({ email: email.trim(), password, ...(mode === 'signup' && name.trim() ? { name: name.trim() } : {}) });
  };

  return (
    <main className="grid min-h-full place-items-center bg-canvas px-4 py-12">
      <div className="w-full max-w-[520px] rounded-2xl border border-line bg-surface px-8 py-12 sm:px-16">
        <h1 className="text-center text-4xl font-bold tracking-tight">{mode === 'login' ? 'Login' : 'Create account'}</h1>

        {serverError && (
          <div role="alert" className="mt-6 flex gap-2 rounded-lg border border-danger-line bg-danger-soft p-3 text-sm text-danger">
            <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
            {serverError}
          </div>
        )}

        <a
          href={GOOGLE_LOGIN_URL}
          onClick={() => setRedirecting(true)}
          aria-busy={redirecting}
          className="mt-8 flex h-14 w-full items-center justify-center gap-3 rounded-xl bg-brand-50 text-[15px] font-medium text-ink transition-colors hover:bg-brand-100"
        >
          {redirecting ? <Spinner className="size-5" /> : <GoogleIcon />}
          Login with Google
        </a>

        <div className="my-6 flex items-center gap-4 text-sm text-muted" role="separator" aria-label="or">
          <span className="h-px flex-1 bg-line" />
          or sign up through email
          <span className="h-px flex-1 bg-line" />
        </div>

        <form onSubmit={submit} noValidate className="flex flex-col gap-3">
          {mode === 'signup' && (
            <input className={field} type="text" name="name" placeholder="Name (optional)" aria-label="Name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
          )}
          <input
            className={field}
            type="email"
            name="email"
            placeholder="Email ID"
            aria-label="Email ID"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-invalid={emailBad}
            aria-describedby={emailBad ? 'email-err' : undefined}
          />
          {emailBad && <p id="email-err" className="-mt-1 px-1 text-xs text-danger">Enter a valid email address</p>}
          <input
            className={field}
            type="password"
            name="password"
            placeholder="Password"
            aria-label="Password"
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={passBad}
            aria-describedby={passBad ? 'pw-err' : undefined}
            maxLength={128}
          />
          {passBad && <p id="pw-err" className="-mt-1 px-1 text-xs text-danger">{mode === 'signup' ? `Use at least ${PASSWORD_MIN} characters` : 'Enter your password'}</p>}
          <button
            type="submit"
            disabled={auth.isPending}
            className="mt-4 flex h-14 w-full items-center justify-center gap-2 rounded-xl bg-brand-600 text-base font-medium text-on-brand transition-colors hover:bg-brand-700 disabled:opacity-70"
          >
            {auth.isPending && <Spinner className="size-5" />}
            {mode === 'login' ? 'Login' : 'Create account'}
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-muted">
          {mode === 'login' ? 'New here? ' : 'Already have an account? '}
          <button
            type="button"
            className="font-medium text-brand-600 underline-offset-2 hover:underline"
            onClick={() => {
              setMode(mode === 'login' ? 'signup' : 'login');
              setTouched(false);
              auth.reset();
            }}
          >
            {mode === 'login' ? 'Create an account' : 'Log in'}
          </button>
        </p>
      </div>
    </main>
  );
}
