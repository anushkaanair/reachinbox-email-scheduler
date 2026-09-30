import { AlertTriangle, CheckCircle2, CircleHelp, ExternalLink, Flame, PauseCircle, Play, RefreshCw, RotateCcw, Send, XCircle } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { dnsSummary, PROVIDER_LABEL, type DnsReport, type SenderDetail } from '@ri/shared';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { Drawer } from '@/components/ui/Drawer';
import { Input, Textarea } from '@/components/ui/Field';
import {
  useAcknowledge,
  useDnsCheck,
  useReconnect,
  useResumeSender,
  useTestAccount,
  useUpdateSettings,
  useUpdateWarmup,
} from '@/hooks/useSenderHealth';
import { cn } from '@/lib/cn';
import { formatWhen, relative } from '@/lib/format';
import { dayUnit, RampChart, ScoreRing, STATUS, UsageBar, WarmupEditor } from './parts';

const TABS = ['Overview', 'Campaign stats', 'Warm-up', 'Settings'] as const;
type Tab = (typeof TABS)[number];
const nf = new Intl.NumberFormat();

const DNS_ICON = {
  pass: <CheckCircle2 className="size-4 text-st-sent" aria-label="Pass" />,
  fail: <XCircle className="size-4 text-danger" aria-label="Fail" />,
  unknown: <CircleHelp className="size-4 text-muted" aria-label="Couldn’t tell" />,
} as const;

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-line p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function ErrorPanel({ s }: { s: SenderDetail }) {
  const [reconnecting, setReconnecting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const reconnect = useReconnect();
  const ack = useAcknowledge();
  const resume = useResumeSender();
  const form = useForm<{ smtpPass: string }>({ defaultValues: { smtpPass: '' } });

  if (!s.attention) return null;
  return (
    <div role="alert" className="rounded-xl border border-danger-line bg-danger-soft p-4">
      <div className="flex items-start gap-3">
        {s.attention === 'paused' ? <PauseCircle className="mt-0.5 size-5 shrink-0 text-danger" aria-hidden /> : <AlertTriangle className="mt-0.5 size-5 shrink-0 text-danger" aria-hidden />}
        <div className="min-w-0 flex-1 text-sm">
          <p className="font-medium">{s.attention === 'paused' ? `Paused until ${formatWhen(s.pausedUntil)}` : 'This account reported errors'}</p>
          <p className="mt-0.5 break-words text-xs text-soft">
            {s.attention === 'paused' ? `${s.pauseReason ?? ''} Its emails are waiting, not failing.` : s.lastError}
          </p>
          {s.attention === 'paused' && s.lastError && <p className="mt-1 break-words text-xs text-muted">Last error: {s.lastError}</p>}
        </div>
      </div>
      {reconnecting ? (
        <form
          className="mt-3 flex flex-col gap-2"
          onSubmit={form.handleSubmit(({ smtpPass }) => {
            setErr(null);
            reconnect.mutate(
              { id: s.id, body: { smtpPass } },
              { onSuccess: () => { toast.success(`${s.email} reconnected`); setReconnecting(false); form.reset(); }, onError: (e) => setErr(e.message) },
            );
          })}
        >
          <Input label="New password" type="password" autoComplete="new-password" error={err ?? form.formState.errors.smtpPass?.message} {...form.register('smtpPass', { required: 'Required' })} />
          <div className="flex gap-2">
            <Button type="submit" size="sm" loading={reconnect.isPending}>Reconnect</Button>
            <Button size="sm" variant="ghost" onClick={() => setReconnecting(false)}>Cancel</Button>
          </div>
        </form>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={() => setReconnecting(true)}>
            <RefreshCw className="size-4" /> Reconnect
          </Button>
          <Button size="sm" variant="ghost" loading={ack.isPending} onClick={() => ack.mutate(s.id, { onSuccess: () => toast('Marked as handled') })}>
            Acknowledge
          </Button>
          {s.attention === 'paused' && (
            <Button size="sm" variant="ghost" loading={resume.isPending} onClick={() => resume.mutate(s.id, { onSuccess: () => toast.success(`${s.email} resumed`) })}>
              <Play className="size-4" /> Resume now
            </Button>
          )}
        </div>
      )}
      <p className="mt-2 text-[11px] text-muted">Reconnect if the password changed. Acknowledge if you fixed it at your provider (suspension, limits, permissions).</p>
    </div>
  );
}

function TestEmail({ s }: { s: SenderDetail }) {
  const test = useTestAccount();
  const [to, setTo] = useState('');
  const [result, setResult] = useState<{ ok: boolean; previewUrl: string | null; error: string | null } | null>(null);
  return (
    <Section title="Send a test email to check connectivity">
      <form
        className="flex flex-col gap-2 sm:flex-row sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          setResult(null);
          test.mutate({ id: s.id, to }, { onSuccess: setResult, onError: (err) => setResult({ ok: false, previewUrl: null, error: err.message }) });
        }}
      >
        <div className="flex-1">
          <Input label="Send to" type="email" required placeholder="you@example.com" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <Button type="submit" variant="secondary" loading={test.isPending} disabled={!to}>
          <Send className="size-4" /> Send test
        </Button>
      </form>
      {result && (
        <p role="status" className={cn('mt-2 text-sm', result.ok ? 'text-brand-700' : 'text-danger')}>
          {result.ok ? (
            <>Sent. {result.previewUrl && <a href={result.previewUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline">Open in Ethereal <ExternalLink className="size-3" aria-hidden /></a>}</>
          ) : (
            result.error
          )}
        </p>
      )}
      {!result && s.lastTest && (
        <p className="mt-2 text-xs text-muted">
          Last test {relative(s.lastTest.at)}: {s.lastTest.ok ? 'worked' : 'failed'}.
        </p>
      )}
    </Section>
  );
}

function DnsPanel({ s }: { s: SenderDetail }) {
  const check = useDnsCheck();
  const r: DnsReport | null = s.dns;
  const sum = r ? dnsSummary(r) : null;
  return (
    <Section
      title={`DNS check${sum ? ` · ${sum.pass} pass · ${sum.fail} fail` : ''}`}
      action={
        <Button size="sm" variant="secondary" loading={check.isPending} onClick={() => check.mutate(s.id, { onError: (e) => toast.error(e.message) })}>
          <RefreshCw className="size-4" /> {r ? 'Sync DNS records' : 'Run check'}
        </Button>
      }
    >
      {r ? (
        <>
          <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
            {([['SPF', r.spf], ['DKIM', r.dkim], ['DMARC', r.dmarc], ['MX', r.mx]] as const).map(([k, v]) => (
              <div key={k}>
                <dt className="flex items-center gap-1.5 text-sm font-medium">{DNS_ICON[v.status]} {k}</dt>
                <dd className="text-xs text-muted">{v.detail}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-[11px] text-muted">{r.domain} · checked {relative(r.checkedAt)}. Re-run after any DNS change.</p>
        </>
      ) : (
        <p className="text-sm text-muted">Checks that {s.email.split('@')[1]} has SPF, DKIM, DMARC and MX records, which decide whether mail lands in the inbox.</p>
      )}
    </Section>
  );
}

function Overview({ s }: { s: SenderDetail }) {
  const warm = useUpdateWarmup();
  const st = STATUS[s.health.status];
  return (
    <div className="flex flex-col gap-4">
      <ErrorPanel s={s} />
      <TestEmail s={s} />
      <Section
        title="Warm-up"
        action={
          <Checkbox
            label={s.warmup.enabled ? 'On' : 'Off'}
            checked={s.warmup.enabled}
            disabled={warm.isPending}
            onChange={(e) => warm.mutate({ id: s.id, body: { enabled: e.target.checked } }, { onSuccess: () => toast(e.target.checked ? 'Warm-up on' : 'Warm-up off — daily cap lifted') })}
          />
        }
      >
        <p className="text-sm text-soft">
          {!s.warmup.enabled ? 'Off. Turn on to start slowly and send a little more each day.' : s.warmup.complete ? 'Complete — sending at full volume.' : <>Day <b>{s.warmup.day}</b> · up to <b>{s.warmup.capToday}</b> emails today · {s.sentToday} sent</>}
        </p>
      </Section>
      <div className="grid gap-4 sm:grid-cols-2">
        <DnsPanel s={s} />
        <Section title="Health score">
          <div className="flex items-center gap-4">
            <ScoreRing score={s.health.score} status={s.health.status} />
            <div className="min-w-0">
              <Badge tone={st.tone}>{st.label}</Badge>
              <ul className="mt-1.5 flex flex-col gap-0.5 text-xs text-muted">{s.health.reasons.slice(0, 3).map((r) => <li key={r}>{r}</li>)}</ul>
            </div>
          </div>
          <p className="mt-2 text-[11px] text-muted">Based on the last {s.healthWindowDays} days of failures, bounces and errors.</p>
        </Section>
      </div>
    </div>
  );
}

function CampaignStats({ s }: { s: SenderDetail }) {
  const attempts = s.stats.sent + s.stats.failed;
  return (
    <div className="flex flex-col gap-4">
      <Section title={`Last ${s.healthWindowDays} days`}>
        <dl className="grid grid-cols-2 gap-3 text-center sm:grid-cols-4">
          {[['Sent', s.stats.sent], ['Failed', s.stats.failed], ['Bounced', s.stats.hardBounces], ['Deferred', s.stats.deferred]].map(([k, v]) => (
            <div key={k as string} className="rounded-lg bg-canvas px-2 py-3">
              <dd className="text-xl font-semibold tabular-nums">{nf.format(v as number)}</dd>
              <dt className="text-xs text-muted">{k}</dt>
            </div>
          ))}
        </dl>
        <p className="mt-2 text-xs text-muted">{attempts ? `${Math.round((s.stats.sent / attempts) * 100)}% delivered` : 'No sends yet'} · used in {s.campaignCount} campaign{s.campaignCount === 1 ? '' : 's'} · {s.bouncedToday} bounced today</p>
      </Section>
      <Section title="Current usage">
        <div className="flex flex-col gap-3">
          <UsageBar label="This hour" used={s.usedThisWindow} max={s.hourlyLimit} />
          <UsageBar label={`Today (this ${dayUnit(s.dayLengthSeconds)})`} used={s.sentToday} max={Math.min(s.warmup.capToday ?? Infinity, s.dailyLimit ?? Infinity) === Infinity ? undefined : Math.min(s.warmup.capToday ?? Infinity, s.dailyLimit ?? Infinity)} note={s.dailyLimit ? 'daily limit' : s.warmup.capToday ? 'warm-up cap' : 'no daily cap'} />
        </div>
      </Section>
    </div>
  );
}

function WarmupTab({ s }: { s: SenderDetail }) {
  const [editing, setEditing] = useState(false);
  const update = useUpdateWarmup();
  const w = s.warmup;
  return (
    <div className="flex flex-col gap-4">
      <Section title="Warm-up ramp" action={<Flame className="size-4 text-warn" aria-hidden />}>
        {editing || !w.enabled ? (
          !w.enabled && !editing ? (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-muted">Off. New mailboxes should start slowly: a few emails on day 1 and a few more each {dayUnit(s.dayLengthSeconds)}, until full volume.</p>
              <Button size="sm" className="w-fit" onClick={() => setEditing(true)}>Set up warm-up</Button>
            </div>
          ) : (
            <WarmupEditor s={s} onDone={() => setEditing(false)} />
          )
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-sm">{w.complete ? 'Warm-up complete — sending at full volume.' : <><b>Day {w.day}</b> of {w.plan.length} · up to <b>{w.capToday}</b> emails today</>}</p>
            <RampChart s={s} />
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>Edit ramp</Button>
              <Button size="sm" variant="ghost" loading={update.isPending} onClick={() => update.mutate({ id: s.id, body: { enabled: true, restart: true } }, { onSuccess: () => toast('Warm-up restarted from day 1') })}>
                <RotateCcw className="size-4" /> Restart
              </Button>
              <Button size="sm" variant="ghost" loading={update.isPending} onClick={() => update.mutate({ id: s.id, body: { enabled: false } }, { onSuccess: () => toast('Warm-up off') })}>Turn off</Button>
            </div>
          </div>
        )}
      </Section>
      <p className="text-xs text-muted">Warm-up here is a sending ramp: a daily cap that grows until full volume. It doesn’t exchange practice emails with other inboxes. The lower of the warm-up cap and the account’s daily limit applies.</p>
    </div>
  );
}

type SettingsForm = { firstName: string; lastName: string; dailyLimit: string; hourlyLimit: string; minDelaySeconds: string; signature: string; replyTo: string; tags: string };

function SettingsTab({ s }: { s: SenderDetail }) {
  const save = useUpdateSettings();
  const [err, setErr] = useState<string | null>(null);
  const form = useForm<SettingsForm>({
    defaultValues: {
      firstName: s.firstName,
      lastName: s.lastName,
      dailyLimit: s.dailyLimit?.toString() ?? '',
      hourlyLimit: s.hourlyLimitOverride?.toString() ?? '',
      minDelaySeconds: s.minDelaySeconds?.toString() ?? '',
      signature: s.signature ?? '',
      replyTo: s.replyTo ?? '',
      tags: s.tags.join(', '),
    },
  });
  const num = (v: string) => (v.trim() === '' ? null : Number(v));
  const e = form.formState.errors;
  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={form.handleSubmit((v) => {
        setErr(null);
        save.mutate(
          {
            id: s.id,
            body: {
              firstName: v.firstName,
              lastName: v.lastName,
              dailyLimit: num(v.dailyLimit),
              hourlyLimit: num(v.hourlyLimit),
              minDelaySeconds: num(v.minDelaySeconds),
              signature: v.signature,
              replyTo: v.replyTo.trim() || null,
              tags: v.tags.split(',').map((t) => t.trim()).filter(Boolean),
            },
          },
          { onSuccess: () => toast.success('Settings saved'), onError: (x) => setErr(x.message) },
        );
      })}
    >
      <Section title="Account details">
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label="First name" hint="Used as the sender name." error={e.firstName?.message} {...form.register('firstName', { required: 'Required' })} />
          <Input label="Last name" {...form.register('lastName')} />
        </div>
        <div className="mt-3">
          <Textarea label="Signature" rows={4} hint="Added under every email from this account. Keep it short and link-free for better deliverability." {...form.register('signature')} />
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Input label="Tags" hint="Comma-separated, up to 10." {...form.register('tags')} />
          <Input label="Reply-to address" type="email" hint="Replies go here instead." error={e.replyTo?.message} {...form.register('replyTo', { pattern: { value: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, message: 'Enter a valid email address' } })} />
        </div>
      </Section>
      <Section title="Sending limits">
        <div className="grid gap-3 sm:grid-cols-3">
          <Input label="Daily limit" type="number" min={1} hint="Emails per day. Blank = none." {...form.register('dailyLimit')} />
          <Input label="Hourly limit" type="number" min={1} hint="Blank = server default." {...form.register('hourlyLimit')} />
          <Input label="Min. delay (seconds)" type="number" min={0} hint="Between sends. Can only raise the server minimum." {...form.register('minDelaySeconds')} />
        </div>
      </Section>
      {err && <p role="alert" className="text-sm text-danger">{err}</p>}
      <div className="flex justify-end"><Button type="submit" loading={save.isPending}>Save changes</Button></div>
    </form>
  );
}

/** Slide-over for one account; the four tabs mirror the reference product's Overview / Campaign Stats / Warm-up / Account Settings. */
export function AccountDrawer({ account, onClose }: { account: SenderDetail | null; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('Overview');
  const s = account;
  return (
    <Drawer
      open={s !== null}
      onClose={onClose}
      title={
        s && (
          <div>
            <p className="truncate text-base font-semibold">{s.email}</p>
            <p className="text-xs text-muted">{PROVIDER_LABEL[s.provider]}{s.tags.length > 0 && ` · ${s.tags.join(', ')}`}</p>
          </div>
        )
      }
    >
      {s && (
        <div className="flex flex-col gap-4">
          <div role="tablist" aria-label="Account sections" className="flex gap-1 overflow-x-auto border-b border-line">
            {TABS.map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className={cn('-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors', tab === t ? 'border-brand-600 text-brand-700' : 'border-transparent text-muted hover:text-ink')}
              >
                {t}
              </button>
            ))}
          </div>
          <div role="tabpanel">
            {tab === 'Overview' && <Overview s={s} />}
            {tab === 'Campaign stats' && <CampaignStats s={s} />}
            {tab === 'Warm-up' && <WarmupTab s={s} />}
            {tab === 'Settings' && <SettingsTab key={s.id + JSON.stringify([s.dailyLimit, s.signature, s.tags])} s={s} />}
          </div>
        </div>
      )}
    </Drawer>
  );
}
