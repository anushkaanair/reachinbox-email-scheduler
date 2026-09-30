import { Compass, PlayCircle, RotateCcw, Sparkles } from 'lucide-react';
import { Link } from 'react-router-dom';
import { recommendSetup, ROLES } from '@ri/shared';
import { Checklist, ProgressBar } from '@/components/onboarding/Checklist';
import { Button, buttonClass } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { useOnboarding, useUpdateOnboarding } from '@/hooks/useOnboarding';

export function GettingStartedPage() {
  const { data, isPending, error } = useOnboarding();
  const update = useUpdateOnboarding();
  const profile = data?.state?.profile ?? null;
  const rec = profile ? recommendSetup(profile) : null;

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Getting started</h1>
          <p className="text-sm text-muted">Set up once, and you’re ready to send. Steps tick off automatically.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={() => update.mutate({ action: 'tour', status: 'pending' })}>
            <PlayCircle className="size-4" /> Restart tour
          </Button>
          <Link to="/onboarding" className={buttonClass('secondary', 'sm')}>
            <RotateCcw className="size-4" /> {profile ? 'Change my answers' : 'Personalise'}
          </Link>
        </div>
      </div>

      {error ? (
        <p role="alert" className="rounded-xl bg-danger-soft p-4 text-sm text-danger">Couldn’t load your setup: {error.message}</p>
      ) : isPending ? (
        <Skeleton className="h-96 w-full rounded-2xl" />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
          <section aria-labelledby="cl" className="rounded-2xl border border-line bg-surface p-5">
            <div className="mb-1 flex items-baseline justify-between">
              <h2 id="cl" className="text-base font-semibold">Setup checklist</h2>
              <span className="text-xs text-muted">{data.progress.done} of {data.progress.total} complete</span>
            </div>
            <div className="mb-4"><ProgressBar percent={data.progress.percent} label="Setup progress" /></div>
            {data.progress.complete && (
              <p className="mb-3 flex items-center gap-2 rounded-xl bg-brand-50 px-3 py-2 text-sm text-brand-700"><Sparkles className="size-4" aria-hidden /> Core setup complete. Optional steps are worth a look.</p>
            )}
            <Checklist steps={data.checklist} />
          </section>

          <aside aria-labelledby="rec" className="flex flex-col gap-4">
            {rec && profile ? (
              <section className="rounded-2xl border border-brand-600/30 bg-brand-50/40 p-5">
                <h2 id="rec" className="text-base font-semibold">Your recommended setup</h2>
                <p className="mt-0.5 text-xs text-muted">{ROLES.find((r) => r.id === profile.role)!.label}</p>
                <p className="mt-3 text-sm"><b>{rec.accounts}</b> mailbox{rec.accounts === 1 ? '' : 'es'} at about <b>{rec.dailyPerAccount}</b> emails a day each, after <b>{rec.warmupWeeks}</b> week{rec.warmupWeeks === 1 ? '' : 's'} of warm-up.</p>
                <ul className="mt-3 flex list-disc flex-col gap-1.5 pl-5 text-xs text-soft">{rec.tips.map((t) => <li key={t}>{t}</li>)}</ul>
              </section>
            ) : (
              <section className="rounded-2xl border border-line bg-surface p-5">
                <h2 id="rec" className="flex items-center gap-2 text-base font-semibold"><Compass className="size-4" aria-hidden /> Get a tailored setup</h2>
                <p className="mt-1 text-sm text-muted">Answer four quick questions and we’ll recommend how many mailboxes to connect and how hard to push them.</p>
                <Link to="/onboarding" className={buttonClass('primary', 'sm', 'mt-3')}>Personalise</Link>
              </section>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
