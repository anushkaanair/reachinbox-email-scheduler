import { zodResolver } from '@hookform/resolvers/zod';
import { AlertTriangle, ArrowLeft, CalendarClock, Send } from 'lucide-react';
import { useMemo, useRef, useState, type FormEvent } from 'react';
import { applySpamFix, spintaxError, type SpamField } from '@ri/shared';
import { useForm } from 'react-hook-form';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { z } from 'zod';
import { ApiError } from '@/api/client';
import { ContentCheckCard } from '@/components/compose/ContentCheckCard';
import { ForecastCard } from '@/components/compose/ForecastCard';
import { LeadsUpload, type UploadedLeads } from '@/components/compose/LeadsUpload';
import { PreviewCard } from '@/components/compose/PreviewCard';
import { SendingRules, defaultRules, hoursError, rulesToSendWindow, type Rules } from '@/components/compose/SendingRules';
import { Button } from '@/components/ui/Button';
import { Input, Select, Textarea } from '@/components/ui/Field';
import { usePreflight, useSuppressions } from '@/hooks/useCompose';
import { useScheduleCampaign, useSenders } from '@/hooks/useCampaigns';
import { useDebounced } from '@/hooks/useIntegrations';
import { formatWhen } from '@/lib/format';
import { QUICK_STARTS, estimateFinish, toLocalInput } from '@/lib/schedule';

const spintaxRefine = (v: string, ctx: z.RefinementCtx) => {
  const err = spintaxError(v);
  if (err) ctx.addIssue({ code: z.ZodIssueCode.custom, message: err });
};

const JITTER_OPTIONS = [
  { value: 0, label: 'Off — exact spacing' },
  { value: 10, label: '±10%' },
  { value: 25, label: '±25% (recommended)' },
  { value: 50, label: '±50%' },
];

const FormSchema = z.object({
  senderId: z.string(),
  subject: z.string().trim().min(1, 'Subject is required').max(300, 'Keep the subject under 300 characters').superRefine(spintaxRefine),
  body: z.string().trim().min(1, 'Body is required').superRefine(spintaxRefine),
  jitterPercent: z.coerce.number().int().min(0).max(50),
  startAt: z
    .string()
    .min(1, 'Pick a start time')
    .refine((v) => new Date(v).getTime() >= Date.now() - 60_000, 'Start time is in the past'),
  delayBetweenSeconds: z.coerce.number({ invalid_type_error: 'Enter a number' }).int('Whole seconds only').min(0).max(86_400),
  hourlyLimit: z.coerce.number({ invalid_type_error: 'Enter a number' }).int('Whole number').min(1, 'At least 1').max(10_000),
});
type FormValues = z.infer<typeof FormSchema>;

const nf = new Intl.NumberFormat();

export function ComposePage() {
  const navigate = useNavigate();
  const senders = useSenders();
  const schedule = useScheduleCampaign();
  const dnc = useSuppressions();
  const [leads, setLeads] = useState<UploadedLeads | null>(null);
  const [leadsError, setLeadsError] = useState<string>();
  const [leadsKey, setLeadsKey] = useState(''); // identifies the uploaded list in the forecast cache
  const [rules, setRules] = useState<Rules>(defaultRules);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);

  const form = useForm<FormValues>({
    resolver: zodResolver(FormSchema),
    defaultValues: {
      senderId: '',
      subject: '',
      body: '',
      startAt: toLocalInput(new Date(Date.now() + 5 * 60_000)),
      delayBetweenSeconds: 2,
      hourlyLimit: 50,
      jitterPercent: 0,
    },
  });
  const { register, handleSubmit, setValue, getValues, watch, setError, formState } = form;
  const { errors } = formState;
  const bodyField = register('body');

  const [senderId, startAt, delay, hourly, jitter, subject, body] = watch([
    'senderId',
    'startAt',
    'delayBetweenSeconds',
    'hourlyLimit',
    'jitterPercent',
    'subject',
    'body',
  ]);
  const activeSenders = senders.data ?? [];
  const chosen = senderId ? activeSenders.filter((s) => s.id === senderId) : activeSenders;
  const noSenders = senders.isSuccess && activeSenders.length === 0;
  const rulesError = hoursError(rules);

  // ── Pre-flight: lead report + window-by-window forecast (debounced, read-only) ──
  const startIso = useMemo(() => {
    const d = new Date(startAt);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }, [startAt]);
  const params = useMemo(() => {
    const delayN = Number(delay);
    const hourlyN = Number(hourly);
    if (!leads || !startIso || !Number.isInteger(delayN) || delayN < 0 || !Number.isInteger(hourlyN) || hourlyN < 1 || rulesError) return null;
    return {
      emails: leads.leads.map((l) => l.email),
      startAt: startIso,
      delayBetweenSeconds: delayN,
      hourlyLimit: hourlyN,
      senderIds: senderId ? [senderId] : undefined,
      sendWindow: rulesToSendWindow(rules),
      skipRecentDays: rules.skipOn ? rules.skipDays : 0,
      jitterPercent: Number(jitter) || 0,
    };
  }, [leads, startIso, delay, hourly, jitter, senderId, rules, rulesError]);
  const debouncedParams = useDebounced(params, 500);
  const pre = usePreflight(debouncedParams, leadsKey);
  const forecastLoading = pre.isFetching || (params !== null && debouncedParams !== params);

  // Fallback estimate until the first server forecast arrives.
  const localEta = useMemo(() => {
    const start = new Date(startAt);
    if (!leads || Number.isNaN(start.getTime())) return null;
    const capacity = chosen.reduce((s, x) => s + x.hourlyLimit, 0);
    return estimateFinish(leads.leads.length, start, Number(delay) || 0, Number(hourly) || 1, capacity);
  }, [leads, startAt, delay, hourly, chosen]);

  const report = pre.data;
  const sendable = report?.sendable ?? leads?.leads.length ?? 0;
  const nothingToSend = Boolean(report && report.sendable === 0);
  const finish = report?.forecast.finishAt ?? localEta?.toISOString() ?? null;
  const first = report?.forecast.firstSendAt ?? (startIso ?? null);

  const liveSubjectErr = spintaxError(subject) ?? undefined;
  const liveBodyErr = spintaxError(body) ?? undefined;

  /** Swap a flagged phrase for the suggested one, in the field it came from. */
  const applyFix = (field: SpamField, match: string, replacement: string) =>
    setValue(field, applySpamFix(getValues(field), match, replacement), { shouldDirty: true, shouldValidate: formState.isSubmitted });

  /** Insert any text at the cursor in the body. */
  const insertText = (snippet: string) => {
    const el = bodyRef.current;
    const text = getValues('body');
    const at = el?.selectionStart ?? text.length;
    setValue('body', `${text.slice(0, at)}${snippet}${text.slice(el?.selectionEnd ?? at)}`, { shouldDirty: true, shouldValidate: formState.isSubmitted });
    el?.focus();
    el?.setSelectionRange(at + snippet.length, at + snippet.length);
  };

  /** Insert a {{tag}} at the cursor in the body. */
  const insertTag = (tag: string) => {
    const el = bodyRef.current;
    const text = getValues('body');
    const at = el?.selectionStart ?? text.length;
    const next = `${text.slice(0, at)}{{${tag}}}${text.slice(el?.selectionEnd ?? at)}`;
    setValue('body', next, { shouldDirty: true, shouldValidate: formState.isSubmitted });
    // setValue writes the DOM value synchronously, so the caret can be restored right away.
    const caret = at + tag.length + 4;
    el?.focus();
    el?.setSelectionRange(caret, caret);
  };

  const NO_LEADS = 'Upload a CSV or TXT file with at least one email address';
  const submitValid = handleSubmit((v) => {
    if (!leads?.leads.length) return setLeadsError(NO_LEADS);
    if (rulesError) return;
    schedule.mutate(
      {
        subject: v.subject,
        body: v.body,
        leads: leads.leads,
        startAt: new Date(v.startAt).toISOString(),
        delayBetweenSeconds: v.delayBetweenSeconds,
        hourlyLimit: v.hourlyLimit,
        senderIds: v.senderId ? [v.senderId] : undefined,
        sendWindow: rulesToSendWindow(rules),
        skipRecentDays: rules.skipOn ? rules.skipDays : 0,
        jitterPercent: v.jitterPercent,
      },
      {
        onSuccess: (res) => {
          const extras = [
            res.invalid.length ? `${res.invalid.length} invalid skipped` : '',
            res.duplicates ? `${res.duplicates} duplicates removed` : '',
            res.suppressed ? `${res.suppressed} on do-not-contact list skipped` : '',
            res.recentlyEmailed ? `${res.recentlyEmailed} recently emailed skipped` : '',
          ].filter(Boolean);
          toast.success(`Scheduled ${nf.format(res.accepted)} email${res.accepted === 1 ? '' : 's'}`, {
            description: [`First ${formatWhen(res.firstSendAt)}`, `finishes ≈ ${formatWhen(res.estimatedFinishAt)}`, ...extras].join(' · '),
          });
          navigate('/dashboard/scheduled');
        },
        onError: (err) => {
          // Surface server-side validation next to the offending fields too.
          const fieldErrors = (err instanceof ApiError && err.code === 'VALIDATION'
            ? (err.details as { fieldErrors?: Record<string, string[]> } | undefined)?.fieldErrors
            : undefined) ?? {};
          for (const [field, msgs] of Object.entries(fieldErrors)) {
            if (field === 'leads') setLeadsError(msgs[0]);
            else if (field in FormSchema.shape) setError(field as keyof FormValues, { message: msgs[0] });
          }
        },
      },
    );
  });

  // Leads live outside react-hook-form; flag them in the same pass as field errors.
  const onSubmit = (e: FormEvent) => {
    if (!leads?.leads.length) setLeadsError(NO_LEADS);
    return submitValid(e);
  };

  const blocked = noSenders || nothingToSend || Boolean(rulesError);

  return (
    <form onSubmit={onSubmit} noValidate className="mx-auto max-w-6xl">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link to="/dashboard" className="mb-1 inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
            <ArrowLeft className="size-4" /> Back
          </Link>
          <h1 className="text-2xl font-bold tracking-tight">Compose New Email</h1>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => navigate('/dashboard')}>
            Cancel
          </Button>
          <Button type="submit" loading={schedule.isPending} disabled={blocked}>
            <CalendarClock className="size-4" /> Schedule
          </Button>
        </div>
      </div>

      {noSenders && (
        <div role="alert" className="mb-5 flex gap-2 rounded-lg border border-warn-line bg-warn-soft p-3 text-sm text-warn">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          No sending accounts are configured. Run <code className="font-mono">npm run senders:create -w @ri/api</code>.
        </div>
      )}

      <div className="grid gap-6 @4xl:grid-cols-[1fr_360px]">
        <div className="flex min-w-0 flex-col gap-6">
          <section className="flex flex-col gap-5 rounded-xl border border-line bg-surface p-5 md:p-6" aria-label="Message">
            <Select label="From" {...register('senderId')} disabled={senders.isPending}>
              <option value="">
                {senders.isPending ? 'Loading senders…' : `All senders · round-robin (${activeSenders.length})`}
              </option>
              {activeSenders.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.email} — {s.usedThisWindow}/{s.hourlyLimit} this hour
                </option>
              ))}
            </Select>

            <LeadsUpload
              value={leads}
              onChange={(v) => {
                setLeads(v);
                setLeadsKey(crypto.randomUUID());
                setLeadsError(undefined);
              }}
              error={leadsError}
            />

            <Input label="Subject" placeholder="{Quick|Short} question, {{name}}" error={errors.subject?.message ?? liveSubjectErr} {...register('subject')} />

            <div className="flex flex-col gap-2">
              <Textarea
                label="Body"
                rows={12}
                placeholder={'Hi {{name}},\n\nWrite your email here…'}
                error={errors.body?.message ?? liveBodyErr}
                {...bodyField}
                ref={(el) => {
                  bodyField.ref(el);
                  bodyRef.current = el;
                }}
              />
              <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
                <span>Insert:</span>
                {(leads?.tags ?? ['email', 'name']).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onMouseDown={(e) => e.preventDefault()} // keep focus + caret in the body
                    onClick={() => insertTag(t)}
                    className="rounded-md border border-line bg-canvas px-2 py-0.5 font-mono text-ink hover:border-brand-500 hover:text-brand-700"
                  >
                    {`{{${t}}}`}
                  </button>
                ))}
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => insertText('{Hi|Hello|Hey}')}
                  title="Spintax: each recipient gets one of the options"
                  className="rounded-md border border-accent/40 bg-accent-soft px-2 py-0.5 font-mono text-accent hover:border-accent"
                >
                  {'{a|b}'}
                </button>
              </div>
              <p className="text-xs text-muted">
                Tip: write <code className="font-mono text-soft">{'{Hi|Hello|Hey}'}</code> to vary wording — each recipient gets one option, and the preview shows theirs.
              </p>
            </div>
          </section>

          <ContentCheckCard subject={subject} body={body} onFix={applyFix} />

          <PreviewCard leads={leads?.leads ?? null} subject={subject} body={body} senderId={senderId} />
        </div>

        <div className="flex min-w-0 flex-col gap-6 @4xl:self-start">
          <aside className="flex flex-col gap-5 rounded-xl border border-line bg-surface p-5 md:p-6" aria-label="Sending schedule">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Schedule</h2>
            <div className="flex flex-col gap-2">
              <Input type="datetime-local" label="Start time" error={errors.startAt?.message} {...register('startAt')} />
              <div className="flex flex-wrap gap-1.5">
                {QUICK_STARTS.map((q) => (
                  <button
                    key={q.label}
                    type="button"
                    onClick={() => setValue('startAt', toLocalInput(q.at()), { shouldValidate: true })}
                    className="rounded-full border border-line px-2.5 py-1 text-xs text-muted hover:border-brand-500 hover:text-brand-700"
                  >
                    {q.label}
                  </button>
                ))}
              </div>
            </div>
            <Input
              type="number"
              min={0}
              label="Delay between emails (seconds)"
              error={errors.delayBetweenSeconds?.message}
              {...register('delayBetweenSeconds')}
            />
            <Select
              label="Randomise gaps"
              hint={
                Number(delay) > 0
                  ? `Gaps vary between ${Math.round(Number(delay) * (1 - Number(jitter) / 100))}s and ${Math.round(Number(delay) * (1 + Number(jitter) / 100))}s so the cadence looks human. The per-sender minimum always holds.`
                  : 'Needs a delay above 0 to have any effect.'
              }
              {...register('jitterPercent')}
            >
              {JITTER_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
            <Input
              type="number"
              min={1}
              label="Hourly limit"
              hint="Max emails per hour for this campaign"
              error={errors.hourlyLimit?.message}
              {...register('hourlyLimit')}
            />

            <dl className="grid grid-cols-2 gap-x-3 gap-y-2 rounded-lg bg-canvas/70 p-3 text-sm">
              <dt className="text-muted">Recipients</dt>
              <dd className="text-right font-medium tabular-nums">{nf.format(sendable)}</dd>
              <dt className="text-muted">Senders</dt>
              <dd className="text-right font-medium tabular-nums">{chosen.length}</dd>
              <dt className="text-muted">First email</dt>
              <dd className="text-right font-medium">{formatWhen(first)}</dd>
              <dt className="text-muted">Est. finish</dt>
              <dd className="text-right font-medium">{finish ? `≈ ${formatWhen(finish)}` : '—'}</dd>
            </dl>

            <Button type="submit" size="lg" loading={schedule.isPending} disabled={blocked} className="w-full">
              <Send className="size-4" /> Schedule {leads ? nf.format(sendable) : ''} emails
            </Button>
          </aside>

          <div className="rounded-xl border border-line bg-surface p-5 md:p-6">
            <SendingRules value={rules} onChange={setRules} dncCount={dnc.data?.total} />
          </div>

          <ForecastCard data={report} loading={forecastLoading} error={pre.error} hasLeads={Boolean(leads)} />
        </div>
      </div>
    </form>
  );
}
