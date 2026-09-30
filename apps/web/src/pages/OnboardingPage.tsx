import { ArrowLeft, ArrowRight, Check } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { GOALS, recommendSetup, ROLES, STAGES, VOLUMES, type OnboardingProfile } from '@ri/shared';
import { Checklist, ProgressBar } from '@/components/onboarding/Checklist';
import { Logo } from '@/components/layout/Logo';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import { useOnboarding, useUpdateOnboarding } from '@/hooks/useOnboarding';
import { cn } from '@/lib/cn';

type Key = keyof OnboardingProfile;
type Choice = { id: string; label: string; hint?: string };

const STEPS: { key: Key; title: string; subtitle: string; options: readonly Choice[]; cols: string }[] = [
  { key: 'role', title: 'What best describes you?', subtitle: 'We’ll use this to tailor your workspace and recommended setup.', options: ROLES, cols: 'sm:grid-cols-2 lg:grid-cols-3' },
  { key: 'goal', title: 'What’s your primary goal?', subtitle: 'We’ll prioritise the right path and recommendations.', options: GOALS, cols: 'sm:grid-cols-2 lg:grid-cols-3' },
  { key: 'stage', title: 'Where are you today?', subtitle: 'This helps us match the right onboarding depth.', options: STAGES, cols: 'sm:grid-cols-2' },
  { key: 'volume', title: 'How many active prospects do you plan to reach each month?', subtitle: 'We’ll recommend the right infrastructure and sending setup for your scale.', options: VOLUMES, cols: 'sm:grid-cols-2' },
];

function Stepper({ step, total }: { step: number; total: number }) {
  return (
    <ol className="flex gap-2 md:flex-col md:items-center" aria-label="Progress">
      {Array.from({ length: total }, (_, i) => (
        <li key={i} className="flex items-center gap-2 md:flex-col" aria-current={i === step ? 'step' : undefined}>
          <span className={cn('grid size-8 place-items-center rounded-full text-xs font-semibold', i <= step ? 'bg-brand-600 text-on-brand' : 'bg-neutral-soft text-muted')}>{i < step ? <Check className="size-4" aria-label="done" /> : i + 1}</span>
          {i < total - 1 && <span className={cn('h-0.5 w-6 md:h-6 md:w-0.5', i < step ? 'bg-brand-600' : 'bg-neutral-soft')} aria-hidden />}
        </li>
      ))}
    </ol>
  );
}

const isComplete = (a: Partial<OnboardingProfile>): a is OnboardingProfile => Boolean(a.role && a.goal && a.stage && a.volume);

/** Four quick questions, then a setup path. Everything is skippable; skipping never limits the account. */
export function OnboardingPage() {
  const navigate = useNavigate();
  const { data } = useOnboarding();
  const update = useUpdateOnboarding();
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<Partial<OnboardingProfile>>(data?.state?.profile ?? {});
  const done = step >= STEPS.length;
  const cur = STEPS[step];
  const profile = isComplete(answers) ? answers : null;

  const save = (finish: 'complete' | 'skip') => {
    const body = finish === 'complete' && profile ? ({ action: 'complete', profile } as const) : ({ action: 'skip' } as const);
    update.mutate(body, {
      onSuccess: () => navigate('/getting-started', { replace: true }),
      onError: (e) => toast.error(e.message),
    });
  };

  return (
    <div className="min-h-full bg-canvas">
      <header className="flex items-center justify-between px-6 py-5 md:px-12">
        <Logo />
        {!done && (
          <Button variant="ghost" size="sm" loading={update.isPending} onClick={() => save('skip')}>
            Skip personalisation
          </Button>
        )}
      </header>
      <main className="mx-auto grid max-w-5xl gap-8 px-6 pb-16 md:grid-cols-[3rem_1fr] md:gap-12">
        <Stepper step={step} total={STEPS.length} />
        {!done && cur ? (
          <section aria-labelledby="q-title">
            <h1 id="q-title" className="text-2xl font-bold tracking-tight md:text-3xl">{cur.title}</h1>
            <p className="mt-1 text-muted">{cur.subtitle}</p>
            <div role="radiogroup" aria-labelledby="q-title" className={cn('mt-6 grid gap-3', cur.cols)}>
              {cur.options.map((o) => {
                const on = answers[cur.key] === o.id;
                return (
                  <button
                    key={o.id}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => setAnswers((a) => ({ ...a, [cur.key]: o.id }))}
                    className={cn('relative rounded-xl border p-4 text-left transition-colors', on ? 'border-brand-600 bg-brand-600 text-on-brand' : 'border-line bg-surface hover:border-brand-500')}
                  >
                    <span className="block text-sm font-semibold">{o.label}</span>
                    {o.hint && <span className={cn('mt-0.5 block text-xs', on ? 'text-on-brand/80' : 'text-muted')}>{o.hint}</span>}
                    {on && <Check className="absolute top-3 right-3 size-4" aria-hidden />}
                  </button>
                );
              })}
            </div>
            <div className="mt-8 flex items-center justify-end gap-3">
              <Button variant="ghost" onClick={() => setStep(Math.max(0, step - 1))} disabled={step === 0}>
                <ArrowLeft className="size-4" /> Go back
              </Button>
              <Button onClick={() => setStep(step + 1)} disabled={!answers[cur.key]}>
                {step === STEPS.length - 1 ? 'See my setup' : 'Continue'} <ArrowRight className="size-4" />
              </Button>
            </div>
          </section>
        ) : profile ? (
          <Result profile={profile} saving={update.isPending} onBack={() => setStep(STEPS.length - 1)} onFinish={() => save('complete')} />
        ) : (
          <Spinner className="size-6" />
        )}
      </main>
    </div>
  );
}

function Result({ profile, saving, onBack, onFinish }: { profile: OnboardingProfile; saving: boolean; onBack: () => void; onFinish: () => void }) {
  const { data } = useOnboarding();
  const rec = recommendSetup(profile);
  return (
    <section aria-labelledby="r-title">
      <h1 id="r-title" className="text-2xl font-bold tracking-tight md:text-3xl">Here’s the best setup path for you</h1>
      <p className="mt-1 max-w-2xl text-muted">{rec.headline}. We’ll walk you through a safe, focused setup so you can {GOALS.find((g) => g.id === profile.goal)!.label.toLowerCase()} without hurting deliverability.</p>
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <div className="rounded-2xl border border-line bg-surface p-5">
          <h2 className="text-base font-semibold">Setup checklist</h2>
          <p className="mb-3 text-xs text-muted">{data ? `${data.progress.done} of ${data.progress.total} complete` : ' '}</p>
          {data && (
            <>
              <ProgressBar percent={data.progress.percent} label="Setup progress" />
              <div className="mt-4"><Checklist steps={data.checklist} /></div>
            </>
          )}
        </div>
        <div className="rounded-2xl border border-brand-600/30 bg-brand-50/40 p-5">
          <h2 className="text-base font-semibold">Recommended sending setup</h2>
          <dl className="mt-3 grid grid-cols-3 gap-3 text-center">
            {[['Mailboxes', rec.accounts], ['Emails/day each', rec.dailyPerAccount], ['Warm-up', `${rec.warmupWeeks} wk`]].map(([k, v]) => (
              <div key={k as string} className="rounded-xl bg-surface p-3">
                <dd className="text-2xl font-semibold tabular-nums">{v}</dd>
                <dt className="text-xs text-muted">{k}</dt>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-xs text-muted">Capacity: about {new Intl.NumberFormat().format(rec.monthlyCapacity)} emails a month, for about {new Intl.NumberFormat().format(VOLUMES.find((v) => v.id === profile.volume)!.leads)} leads with a 3-step sequence.</p>
          <ul className="mt-3 flex list-disc flex-col gap-1.5 pl-5 text-sm text-soft">
            {rec.tips.map((t) => <li key={t}>{t}</li>)}
          </ul>
        </div>
      </div>
      <div className="mt-8 flex flex-wrap items-center gap-3">
        <Button size="lg" loading={saving} onClick={onFinish}>Start setup <ArrowRight className="size-4" /></Button>
        <Button variant="ghost" onClick={onBack}><ArrowLeft className="size-4" /> Change answers</Button>
      </div>
    </section>
  );
}
