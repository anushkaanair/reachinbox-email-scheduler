import { zodResolver } from '@hookform/resolvers/zod';
import { AlertTriangle, ArrowLeft, CalendarClock } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { applySpamFix, htmlLinkUrls, htmlToText, isHtmlEmpty, spintaxError, type DraftPayload, type SpamField } from '@ri/shared';
import { Controller, useForm } from 'react-hook-form';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { z } from 'zod';
import { ApiError } from '@/api/client';
import { ContentCheckCard } from '@/components/compose/ContentCheckCard';
import { ForecastCard } from '@/components/compose/ForecastCard';
import { AttachButton, AttachmentList, useAttachments } from '@/components/compose/Attachments';
import { RecipientsField } from '@/components/compose/RecipientsField';
import { RichTextEditor, type RichTextHandle } from '@/components/compose/RichTextEditor';
import { SavedLists } from '@/components/compose/SavedLists';
import { loadListRecipients } from '@/hooks/useLeadLists';
import { SendLater } from '@/components/compose/SendLater';
import { PreviewCard } from '@/components/compose/PreviewCard';
import { SendingRules, defaultRules, hoursError, rulesToBounceProtection, rulesToSendWindow, type Rules } from '@/components/compose/SendingRules';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Field';
import { usePreflight, useSuppressions } from '@/hooks/useCompose';
import { useScheduleCampaign, useSenders } from '@/hooks/useCampaigns';
import { useDeleteDraft, useDraft, useSaveDraft } from '@/hooks/useDrafts';
import { useDebounced } from '@/hooks/useIntegrations';
import { formatWhen } from '@/lib/format';
import { EMPTY_RECIPIENTS, addLeads, recipientsFromLeads, type Recipients } from '@/lib/recipients';
import { estimateFinish, toLocalInput } from '@/lib/schedule';

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
  body: z.string().trim().min(1, 'Body is required').superRefine(spintaxRefine).refine((v) => !isHtmlEmpty(v), 'Body is required'),
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

/** One label-left row of the Figma compose form. Defined at module level so inputs keep focus between renders. */
function Row({ label, htmlFor, children }: { label: string; htmlFor?: string; children: React.ReactNode }) {
  return (
    <div className="grid items-start gap-x-4 gap-y-1 sm:grid-cols-[5.5rem_1fr]">
      <label htmlFor={htmlFor} className="pt-2.5 text-sm text-ink">{label}</label>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function ComposePage() {
  const navigate = useNavigate();
  const senders = useSenders();
  const schedule = useScheduleCampaign();
  const dnc = useSuppressions();
  const [recipients, setRecipients] = useState<Recipients>(EMPTY_RECIPIENTS);
  const [sendAt, setSendAt] = useState<Date | null>(null); // null = send straight away
  const files = useAttachments();
  const [urlParams] = useSearchParams();
  const [draftId, setDraftId] = useState<string | null>(urlParams.get('draft'));
  const loadedDraft = useRef<string | null>(null);
  const loadedList = useRef<string | null>(null);
  const draft = useDraft(urlParams.get('draft'));
  const saveDraft = useSaveDraft();
  const removeDraft = useDeleteDraft();
  const [leadsError, setLeadsError] = useState<string>();
  const [leadsKey, setLeadsKey] = useState(''); // identifies the uploaded list in the forecast cache
  const [rules, setRules] = useState<Rules>(defaultRules);
  const editor = useRef<RichTextHandle | null>(null);

  const form = useForm<FormValues>({
    resolver: zodResolver(FormSchema),
    defaultValues: {
      senderId: '',
      subject: '',
      body: '',
      startAt: toLocalInput(new Date()),
      delayBetweenSeconds: 2,
      hourlyLimit: 50,
      jitterPercent: 0,
    },
  });
  const { register, handleSubmit, setValue, getValues, watch, setError, formState, control } = form;
  const { errors } = formState;

  const leads = recipients.leads.length > 0 ? recipients : null;
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

  /** Insert any text at the cursor in the body (merge tags, spintax). */
  const insertText = (snippet: string) => editor.current?.insertText(snippet);
  const insertTag = (tag: string) => insertText(`{{${tag}}}`);

  // Opening a draft fills the whole form exactly as it was saved (attachments are not kept in drafts).
  useEffect(() => {
    const d = draft.data;
    if (!d || loadedDraft.current === d.id) return;
    loadedDraft.current = d.id;
    const p = d.payload;
    const when = p.sendAt && new Date(p.sendAt).getTime() > Date.now() ? new Date(p.sendAt) : null;
    form.reset({ senderId: p.senderId, subject: p.subject, body: p.body, startAt: toLocalInput(when ?? new Date()), delayBetweenSeconds: p.delayBetweenSeconds, hourlyLimit: p.hourlyLimit, jitterPercent: p.jitterPercent });
    setRecipients(recipientsFromLeads(p.leads));
    setLeadsKey(crypto.randomUUID());
    setSendAt(when);
    if (p.rules) setRules({ ...defaultRules(), ...p.rules });
    setDraftId(d.id);
  }, [draft.data, form]);

  // "Use in a campaign" from a lead list arrives as ?list=<id>: fill the recipients (undeliverable ones are left out).
  const listParam = urlParams.get('list');
  useEffect(() => {
    if (!listParam || loadedList.current === listParam) return;
    loadedList.current = listParam;
    loadListRecipients(listParam).then(
      (leads) => {
        setRecipients((cur) => addLeads(cur, leads));
        setLeadsKey(crypto.randomUUID());
        toast.success(`Loaded ${leads.length.toLocaleString('en-US')} address${leads.length === 1 ? '' : 'es'} from your list`, { description: 'Any the check found undeliverable were left out.' });
      },
      (e: unknown) => toast.error(e instanceof Error ? e.message : 'Couldn’t load that list'),
    );
  }, [listParam]);

  const snapshot = (): DraftPayload => ({
    senderId,
    subject,
    body,
    leads: recipients.leads,
    sendAt: sendAt ? sendAt.toISOString() : null,
    delayBetweenSeconds: Math.max(0, Math.floor(Number(delay) || 0)),
    hourlyLimit: Math.max(1, Math.floor(Number(hourly) || 1)),
    jitterPercent: Math.min(50, Math.max(0, Math.floor(Number(jitter) || 0))),
    rules,
  });

  const save = () =>
    saveDraft.mutate(
      { id: draftId, payload: snapshot() },
      { onSuccess: (d) => { setDraftId(d.id); toast.success('Draft saved', { description: files.items.length ? 'Attachments aren’t kept in drafts; add them again when you send.' : undefined }); }, onError: (e) => toast.error(e.message) },
    );

  const NO_LEADS = 'Upload a CSV or TXT file with at least one email address';
  const submitValid = handleSubmit((v) => {
    if (!leads?.leads.length) return setLeadsError(NO_LEADS);
    if (rulesError) return;
    schedule.mutate(
      {
        subject: v.subject,
        body: v.body,
        bodyFormat: 'HTML' as const,
        attachmentIds: files.ids,
        leads: leads.leads,
        startAt: new Date(v.startAt).toISOString(),
        delayBetweenSeconds: v.delayBetweenSeconds,
        hourlyLimit: v.hourlyLimit,
        senderIds: v.senderId ? [v.senderId] : undefined,
        sendWindow: rulesToSendWindow(rules),
        skipRecentDays: rules.skipOn ? rules.skipDays : 0,
        jitterPercent: v.jitterPercent,
        bounceProtection: rulesToBounceProtection(rules),
      },
      {
        onSuccess: (res) => {
          if (draftId) removeDraft.mutate(draftId); // it has been sent on; the draft is done
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

  // Recipients live outside react-hook-form; flag them in the same pass as field errors.
  const onSubmit = (e: FormEvent) => {
    if (!leads?.leads.length) setLeadsError(NO_LEADS);
    // "Send" means now: take the clock at the moment of pressing, so a page left open can't be "in the past".
    if (!sendAt) setValue('startAt', toLocalInput(new Date()));
    return submitValid(e);
  };

  const blocked = noSenders || nothingToSend || Boolean(rulesError);
  const sendLabel = sendAt ? 'Send Later' : 'Send';

  const underline = 'h-11 w-full border-b border-line bg-transparent text-[15px] placeholder:text-muted focus:border-brand-600 focus:outline-none aria-[invalid=true]:border-danger-solid';
  const small = 'h-10 w-20 rounded-lg border border-line bg-surface px-3 text-center text-sm placeholder:text-muted focus:border-brand-600 focus:outline-none aria-[invalid=true]:border-danger-solid';

  return (
    <form onSubmit={onSubmit} noValidate className="mx-auto max-w-6xl">
      <div className="mb-6 flex items-center gap-3">
        <Link to="/dashboard" aria-label="Back" className="rounded-full p-1.5 text-ink hover:bg-neutral-soft">
          <ArrowLeft className="size-6" aria-hidden />
        </Link>
        <h1 className="flex-1 text-2xl font-medium tracking-tight">Compose New Email</h1>
        <AttachButton count={files.items.length} busy={files.busy} onPick={(f) => void files.add(f)} />
        <SendLater value={sendAt} onChange={(d) => { setSendAt(d); setValue('startAt', toLocalInput(d ?? new Date()), { shouldValidate: true }); }} />
        <Button
          type="submit"
          variant="secondary"
          loading={schedule.isPending}
          disabled={blocked}
          className="h-10 rounded-full border-brand-600 px-6 text-brand-600 hover:bg-brand-50"
        >
          {sendLabel}
        </Button>
      </div>

      {sendAt && (
        <p className="mb-4 flex items-center gap-2 rounded-lg bg-brand-50 px-3 py-2 text-sm text-brand-700" role="status">
          <CalendarClock className="size-4" aria-hidden /> Scheduled to start {formatWhen(sendAt.toISOString())}
        </p>
      )}
      {errors.startAt?.message && <p role="alert" className="mb-4 text-sm text-danger">{errors.startAt.message}</p>}

      {noSenders && (
        <div role="alert" className="mb-5 flex gap-2 rounded-lg border border-warn-line bg-warn-soft p-3 text-sm text-warn">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            No sending accounts are connected. <Link to="/senders" className="font-medium underline">Connect one on Email accounts</Link>.
          </span>
        </div>
      )}

      <div className="grid gap-x-10 gap-y-8 @4xl:grid-cols-[1fr_340px]">
        <div className="flex min-w-0 flex-col gap-5">
          <section className="flex flex-col gap-5" aria-label="Message">
            <Row label="From" htmlFor="from">
              <select id="from" {...register('senderId')} disabled={senders.isPending} className="h-10 max-w-full rounded-lg bg-neutral-soft px-3 pr-8 text-[15px] focus:ring-2 focus:ring-brand-600/40 focus:outline-none">
                <option value="">{senders.isPending ? 'Loading senders…' : `All senders · round-robin (${activeSenders.length})`}</option>
                {activeSenders.map((s) => (
                  <option key={s.id} value={s.id}>{s.email} — {s.usedThisWindow}/{s.hourlyLimit} this hour</option>
                ))}
              </select>
            </Row>

            <Row label="To">
              <RecipientsField
                value={recipients}
                onChange={(v) => { setRecipients(v); setLeadsKey(crypto.randomUUID()); setLeadsError(undefined); }}
                error={leadsError}
                extra={<SavedLists leads={recipients.leads} onLoad={(leads, name) => { setRecipients((cur) => addLeads(cur, leads)); setLeadsKey(crypto.randomUUID()); setLeadsError(undefined); toast.success(`Added “${name}”`); }} />}
              />
            </Row>

            <Row label="Subject" htmlFor="subject">
              <input id="subject" placeholder="Subject" aria-invalid={Boolean(errors.subject?.message ?? liveSubjectErr)} className={underline} {...register('subject')} />
              {(errors.subject?.message ?? liveSubjectErr) && <p role="alert" className="mt-1 text-xs text-danger">{errors.subject?.message ?? liveSubjectErr}</p>}
            </Row>

            <div className="flex flex-wrap items-center gap-x-6 gap-y-3 sm:pl-[6.25rem]">
              <label className="flex items-center gap-3 text-sm">
                Delay between 2 emails
                <input type="number" min={0} placeholder="00" aria-invalid={Boolean(errors.delayBetweenSeconds)} className={small} {...register('delayBetweenSeconds')} />
                <span className="text-xs text-muted">seconds</span>
              </label>
              <label className="flex items-center gap-3 text-sm">
                Hourly Limit
                <input type="number" min={1} placeholder="00" aria-invalid={Boolean(errors.hourlyLimit)} className={small} {...register('hourlyLimit')} />
              </label>
              {(errors.delayBetweenSeconds?.message || errors.hourlyLimit?.message) && (
                <p role="alert" className="basis-full text-xs text-danger">{errors.delayBetweenSeconds?.message ?? errors.hourlyLimit?.message}</p>
              )}
            </div>

            <div className="flex flex-col gap-2">
              <Controller
                name="body"
                control={control}
                render={({ field }) => (
                  <RichTextEditor
                    ref={editor}
                    value={field.value}
                    onChange={field.onChange}
                    placeholder={'Hi {{name}},\n\nWrite your email here…'}
                    invalid={Boolean(errors.body?.message ?? liveBodyErr)}
                  />
                )}
              />
              {(errors.body?.message ?? liveBodyErr) && <p role="alert" className="text-xs text-danger">{errors.body?.message ?? liveBodyErr}</p>}
              <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
                <span>Insert:</span>
                {(leads?.tags ?? ['email', 'name']).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onMouseDown={(e) => e.preventDefault()} // keep focus + caret in the body
                    onClick={() => insertTag(t)}
                    className="rounded-md border border-line bg-canvas px-2 py-0.5 font-mono text-ink hover:border-brand-600 hover:text-brand-700"
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
                Tip: write <code className="font-mono text-soft">{'{Hi|Hello|Hey}'}</code> to vary wording: each recipient gets one option, and the preview shows theirs.
              </p>
            </div>
          </section>

          <AttachmentList items={files.items} onRemove={(id) => void files.remove(id)} error={files.error} />

          <ContentCheckCard subject={subject} body={htmlToText(body)} links={htmlLinkUrls(body)} onFix={applyFix} />

          <PreviewCard leads={leads?.leads ?? null} subject={subject} body={body} bodyFormat="HTML" senderId={senderId} />
        </div>

        <div className="flex min-w-0 flex-col gap-6 @4xl:self-start">
          <aside className="flex flex-col gap-5 rounded-2xl border border-line bg-surface p-5" aria-label="Summary">
            <h2 className="text-sm font-semibold tracking-wide text-muted uppercase">Summary</h2>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
              <dt className="text-muted">Recipients</dt>
              <dd className="text-right font-medium tabular-nums">{nf.format(sendable)}</dd>
              <dt className="text-muted">Senders</dt>
              <dd className="text-right font-medium tabular-nums">{chosen.length}</dd>
              <dt className="text-muted">First email</dt>
              <dd className="text-right font-medium">{formatWhen(first)}</dd>
              <dt className="text-muted">Est. finish</dt>
              <dd className="text-right font-medium">{finish ? `≈ ${formatWhen(finish)}` : '—'}</dd>
            </dl>
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
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </Select>
            <Button variant="ghost" loading={saveDraft.isPending} onClick={save} className="w-full">
              {draftId ? 'Save changes to draft' : 'Save as draft'}
            </Button>
            <Button type="submit" variant="secondary" loading={schedule.isPending} disabled={blocked} className="w-full rounded-full border-brand-600 text-brand-600 hover:bg-brand-50">
              <CalendarClock className="size-4" aria-hidden /> Schedule {leads ? nf.format(sendable) : ''} email{sendable === 1 ? '' : 's'}
            </Button>
          </aside>

          <div className="rounded-2xl border border-line bg-surface p-5">
            <SendingRules value={rules} onChange={setRules} dncCount={dnc.data?.total} />
          </div>

          <ForecastCard data={report} loading={forecastLoading} error={pre.error} hasLeads={Boolean(leads)} />
        </div>
      </div>
    </form>
  );
}
