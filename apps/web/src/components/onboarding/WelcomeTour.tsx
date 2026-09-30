import { ArrowRight, Eye, Mail, Send, Users, X } from 'lucide-react';
import { useLayoutEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { useOnboarding, useUpdateOnboarding } from '@/hooks/useOnboarding';
import { cn } from '@/lib/cn';

type TourStep = { target: string; title: string; body: string };

/** Each step points at an element carrying data-tour="<key>" (sidebar links, the Compose button). */
export const TOUR_STEPS: TourStep[] = [
  { target: 'compose', title: 'Compose', body: 'Write an email, upload your leads as a CSV, and choose when it starts, the delay between emails and the hourly limit.' },
  { target: '/senders', title: 'Email accounts', body: 'Connect the mailboxes you send from, check their health and DNS, turn on warm-up and set daily limits.' },
  { target: '/dashboard/scheduled', title: 'Scheduled', body: 'Everything waiting to go out, with the time it will send. Emails held back by a limit show when they resume.' },
  { target: '/dashboard/sent', title: 'Sent', body: 'What went out, and whether it worked. Each one links to the message in the inbox.' },
  { target: '/campaigns', title: 'Campaigns', body: 'Live progress for each campaign. Pause, resume or cancel without losing anyone’s place in line.' },
  { target: '/analytics', title: 'Analytics', body: 'Sent, failed and deferred over time, plus how close each sender is to its limit.' },
  { target: '/getting-started', title: 'Getting started', body: 'Your setup checklist lives here, ticked off automatically as you go.' },
];

const GAP = 14;
const CARD_W = 340;

function place(target: Element | null, cardH: number) {
  const r = target?.getBoundingClientRect();
  if (!r || r.width === 0) return { left: Math.max(12, (innerWidth - CARD_W) / 2), top: Math.max(12, innerHeight - cardH - 24), anchored: false };
  const left = Math.min(r.right + GAP, innerWidth - CARD_W - 12);
  const top = Math.min(Math.max(12, r.top + r.height / 2 - cardH / 2), innerHeight - cardH - 12);
  return { left, top, anchored: true, ring: r };
}

function TourCard({ step, index, onNext, onBack, onClose }: { step: TourStep; index: number; onNext: () => void; onBack: () => void; onClose: () => void }) {
  const [pos, setPos] = useState<ReturnType<typeof place> | null>(null);
  useLayoutEffect(() => {
    const measure = () => setPos(place(document.querySelector(`[data-tour="${step.target}"]`), 190));
    measure();
    addEventListener('resize', measure);
    return () => removeEventListener('resize', measure);
  }, [step.target]);
  if (!pos) return null;
  const last = index === TOUR_STEPS.length - 1;
  return (
    <>
      {pos.ring && <span className="pointer-events-none fixed z-50 rounded-lg ring-2 ring-brand-500 ring-offset-2 ring-offset-transparent" style={{ left: pos.ring.left - 2, top: pos.ring.top - 2, width: pos.ring.width + 4, height: pos.ring.height + 4 }} aria-hidden />}
      <div role="dialog" aria-label={`Tour: ${step.title}`} className="fixed z-50 rounded-2xl border border-line bg-surface-solid p-5 shadow-2xl" style={{ left: pos.left, top: pos.top, width: Math.min(CARD_W, innerWidth - 24) }}>
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-base font-semibold">{step.title}</h2>
          <button type="button" onClick={onClose} aria-label="Close tour" className="-m-1 rounded-md p-1 text-muted hover:bg-neutral-soft hover:text-ink"><X className="size-4" /></button>
        </div>
        <p className="mt-1.5 text-sm text-soft">{step.body}</p>
        <div className="mt-4 flex items-center gap-3">
          <ol className="flex flex-1 gap-1" aria-label={`Step ${index + 1} of ${TOUR_STEPS.length}`}>
            {TOUR_STEPS.map((s, i) => <li key={s.target} className={cn('h-1.5 rounded-full transition-all', i === index ? 'w-5 bg-brand-600' : 'w-1.5 bg-neutral-strong')} />)}
          </ol>
          {index > 0 && <Button size="sm" variant="ghost" onClick={onBack}>Back</Button>}
          <Button size="sm" onClick={onNext} autoFocus>{last ? 'Finish' : 'Next step'} <ArrowRight className="size-3.5" /></Button>
        </div>
      </div>
    </>
  );
}

/** First-visit welcome and the guided tour. Shown once; "Restart tour" on Getting started brings it back. */
export function WelcomeTour() {
  const { data } = useOnboarding();
  const update = useUpdateOnboarding();
  const { pathname } = useLocation();
  const [touring, setTouring] = useState<number | null>(null);

  const state = data?.state;
  const showWelcome = Boolean(state && state.tour === 'pending' && touring === null && pathname !== '/onboarding');
  // The modal also fires onClose when *we* close it (starting the tour), so only a user dismissal counts as "skipped".
  const finish = (status: 'done' | 'skipped') => {
    setTouring(null);
    update.mutate({ action: 'tour', status });
  };

  return (
    <>
      <Modal open={showWelcome} onClose={() => showWelcome && finish('skipped')} title="Welcome to ReachInbox!" className="max-w-xl">
        <p className="-mt-1 text-sm text-muted">Take a quick tour to get familiar.</p>
        <ol className="mt-4 grid gap-2 sm:grid-cols-3">
          {[[Mail, 'Connect inboxes', 'Warm up and manage sending'], [Users, 'Add leads', 'Upload a CSV of contacts'], [Send, 'Launch campaign', 'Schedule with your limits']].map(([Icon, t, d]) => {
            const I = Icon as typeof Mail;
            return (
              <li key={t as string} className="rounded-xl bg-brand-50 p-3">
                <I className="mb-1.5 size-5 text-brand-700" aria-hidden />
                <p className="text-sm font-semibold">{t as string}</p>
                <p className="text-xs text-muted">{d as string}</p>
              </li>
            );
          })}
        </ol>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => finish('skipped')}><Eye className="size-4" /> Explore myself</Button>
          <Button onClick={() => setTouring(0)}>Start tour <ArrowRight className="size-4" /></Button>
        </div>
      </Modal>
      {touring !== null && (
        <TourCard
          step={TOUR_STEPS[touring]!}
          index={touring}
          onBack={() => setTouring(Math.max(0, touring - 1))}
          onNext={() => (touring >= TOUR_STEPS.length - 1 ? finish('done') : setTouring(touring + 1))}
          onClose={() => finish('skipped')}
        />
      )}
    </>
  );
}
