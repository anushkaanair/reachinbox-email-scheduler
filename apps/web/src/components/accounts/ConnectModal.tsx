import { ArrowLeft, AtSign, FileSpreadsheet, KeyRound, Mail } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { PROVIDER_LABEL, SMTP_PRESETS, type SenderProvider } from '@ri/shared';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { useConnectAccount } from '@/hooks/useSenderHealth';
import { cn } from '@/lib/cn';

type Method = 'GOOGLE' | 'OUTLOOK' | 'CUSTOM';

const METHODS: { id: Method | 'CSV'; icon: ReactNode; title: string; note: string }[] = [
  { id: 'GOOGLE', icon: <KeyRound className="size-5" />, title: 'Google / Gmail', note: 'App password' },
  { id: 'OUTLOOK', icon: <Mail className="size-5" />, title: 'Microsoft / Outlook', note: 'SMTP login' },
  { id: 'CUSTOM', icon: <AtSign className="size-5" />, title: 'Other provider', note: 'Any SMTP server' },
  { id: 'CSV', icon: <FileSpreadsheet className="size-5" />, title: 'Upload a CSV', note: 'Many at once' },
];

type FormValues = {
  firstName: string;
  lastName: string;
  email: string;
  smtpPass: string;
  smtpHost: string;
  smtpPort: string;
  smtpUser: string;
  dailyLimit: string;
};

const HELP: Record<Method, ReactNode> = {
  GOOGLE: (
    <>
      Turn on 2-Step Verification in your Google account, then create an <b>app password</b> (Security → App passwords) and paste the
      16 characters below. Your normal password won’t work. Each address must be its own real mailbox, not an alias.
    </>
  ),
  OUTLOOK: (
    <>
      Use the mailbox password, or an app password if your organisation requires one. SMTP AUTH must be enabled for the mailbox in the
      Microsoft 365 admin centre.
    </>
  ),
  CUSTOM: <>Enter your provider’s SMTP details. Most providers use port 587 (STARTTLS) or 465 (SSL).</>,
};

function ConnectForm({ method, onBack, onDone }: { method: Method; onBack: () => void; onDone: () => void }) {
  const connect = useConnectAccount();
  const preset = SMTP_PRESETS[method];
  const form = useForm<FormValues>({ defaultValues: { firstName: '', lastName: '', email: '', smtpPass: '', smtpHost: preset?.host ?? '', smtpPort: String(preset?.port ?? 587), smtpUser: '', dailyLimit: '' } });
  const e = form.formState.errors;
  const [serverError, setServerError] = useState<string | null>(null);

  const submit = form.handleSubmit((v) => {
    setServerError(null);
    connect.mutate(
      {
        email: v.email,
        firstName: v.firstName,
        lastName: v.lastName,
        provider: method as SenderProvider,
        smtpPass: v.smtpPass,
        ...(method === 'CUSTOM' || v.smtpHost !== preset?.host ? { smtpHost: v.smtpHost } : {}),
        ...(v.smtpPort ? { smtpPort: Number(v.smtpPort) } : {}),
        ...(v.smtpUser ? { smtpUser: v.smtpUser } : {}),
        ...(v.dailyLimit ? { dailyLimit: Number(v.dailyLimit) } : {}),
      },
      {
        onSuccess: () => {
          toast.success(`${v.email} connected`);
          onDone();
        },
        onError: (err) => setServerError(err.message),
      },
    );
  });

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      <button type="button" onClick={onBack} className="flex w-fit items-center gap-1.5 text-sm text-muted hover:text-ink">
        <ArrowLeft className="size-4" aria-hidden /> Back
      </button>
      <p className="rounded-lg bg-info-soft px-3 py-2 text-xs leading-relaxed text-info">{HELP[method]}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Input label="First name" autoComplete="off" error={e.firstName?.message} {...form.register('firstName', { required: 'Required' })} />
        <Input label="Last name" autoComplete="off" {...form.register('lastName')} />
      </div>
      <Input
        label="Email address"
        type="email"
        autoComplete="off"
        error={e.email?.message}
        {...form.register('email', { required: 'Required', pattern: { value: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, message: 'Enter a valid email address' } })}
      />
      <Input
        label={method === 'GOOGLE' ? 'App password' : 'Password'}
        type="password"
        autoComplete="new-password"
        hint="Stored encrypted. Never shown again."
        error={e.smtpPass?.message}
        {...form.register('smtpPass', { required: 'Required' })}
      />
      {method !== 'GOOGLE' && (
        <div className="grid gap-3 sm:grid-cols-[1fr_7rem]">
          <Input label="SMTP host" readOnly={method === 'OUTLOOK'} error={e.smtpHost?.message} {...form.register('smtpHost', { required: method === 'CUSTOM' ? 'Required' : false })} />
          <Input label="Port" type="number" {...form.register('smtpPort')} />
        </div>
      )}
      {method === 'CUSTOM' && <Input label="SMTP username" hint="Leave blank to use the email address." {...form.register('smtpUser')} />}
      <Input label="Daily sending limit" type="number" min={1} hint="Optional. Campaign emails per day from this account." {...form.register('dailyLimit')} />
      {serverError && (
        <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
          {serverError}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="submit" loading={connect.isPending}>
          {connect.isPending ? 'Checking login…' : 'Connect account'}
        </Button>
      </div>
    </form>
  );
}

/** Pick how to connect: one account by provider, or many from a CSV. */
export function ConnectModal({ open, onClose, onCsv }: { open: boolean; onClose: () => void; onCsv: () => void }) {
  const [method, setMethod] = useState<Method | null>(null);
  const close = () => {
    setMethod(null);
    onClose();
  };
  return (
    <Modal open={open} onClose={close} title={method ? `Connect ${PROVIDER_LABEL[method]}` : 'Connect an email account'} className="max-w-xl">
      {method ? (
        <ConnectForm method={method} onBack={() => setMethod(null)} onDone={close} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {METHODS.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => {
                if (m.id === 'CSV') {
                  close();
                  onCsv();
                } else setMethod(m.id);
              }}
              className={cn('flex items-center gap-3 rounded-xl border border-line bg-surface p-4 text-left transition-colors hover:border-brand-500 hover:bg-brand-50')}
            >
              <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-brand-100 text-brand-700">{m.icon}</span>
              <span>
                <span className="block text-sm font-semibold">{m.title}</span>
                <span className="block text-xs text-muted">{m.note}</span>
              </span>
            </button>
          ))}
          <p className="text-xs text-muted sm:col-span-2">
            We log in to the SMTP server before saving, so a wrong password is caught here instead of when the first campaign goes out.
          </p>
        </div>
      )}
    </Modal>
  );
}
