import { AlertTriangle, BellRing, CheckCircle2, Info, Slack, Unplug } from 'lucide-react';
import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { SLACK_CONNECT_URL } from '@/api/integrations';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { useSlack } from '@/hooks/useIntegrations';
import { formatWhen } from '@/lib/format';

/** Messages for the ?slack= result the OAuth callback redirects back with. */
const RESULTS: Record<string, { kind: 'success' | 'error' | 'info'; text: string }> = {
  connected: { kind: 'success', text: 'Slack connected — send a test message to check it.' },
  denied: { kind: 'info', text: 'Slack connection was cancelled.' },
  invalid_state: { kind: 'error', text: 'That Slack link expired. Please try connecting again.' },
  error: { kind: 'error', text: 'Slack connection failed. Please try again.' },
  not_configured: { kind: 'error', text: 'The Slack app is not configured on the server yet.' },
};

const connect = () => window.location.assign(SLACK_CONNECT_URL);

function SlackCard() {
  const { status, test, disconnect } = useSlack();
  const s = status.data;

  return (
    <section className="rounded-xl border border-line bg-surface" aria-labelledby="slack-title">
      <header className="flex items-start gap-4 border-b border-line p-5">
        <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-[#4A154B] text-white">
          <Slack className="size-6" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="slack-title" className="text-base font-semibold">Slack alerts</h2>
            {s?.connected && s.valid && <Badge tone="success">Connected</Badge>}
            {s?.connected && !s.valid && <Badge tone="warning">Needs reconnect</Badge>}
            {s && !s.connected && <Badge>Not connected</Badge>}
          </div>
          <p className="mt-0.5 text-sm text-muted">
            Get a message the moment any of your senders hits its hourly sending limit.
          </p>
        </div>
      </header>

      <div className="p-5">
        {status.isPending ? (
          <div className="space-y-2">
            <Skeleton className="h-4 w-64" />
            <Skeleton className="h-9 w-36" />
          </div>
        ) : status.error ? (
          <p className="text-sm text-red-600">Couldn’t load Slack status: {status.error.message}</p>
        ) : !s!.configured ? (
          <div className="flex gap-2 rounded-lg bg-canvas p-3 text-sm text-muted">
            <Info className="mt-0.5 size-4 shrink-0" />
            <span>
              The server has no Slack app yet. Set <code className="font-mono text-ink">SLACK_CLIENT_ID</code>,{' '}
              <code className="font-mono text-ink">SLACK_CLIENT_SECRET</code> and{' '}
              <code className="font-mono text-ink">SLACK_REDIRECT_URI</code> in <code className="font-mono text-ink">.env</code>.
            </span>
          </div>
        ) : !s!.connected ? (
          <Button onClick={connect} className="bg-[#4A154B] hover:bg-[#3a1039]">
            <Slack className="size-4" /> Connect Slack
          </Button>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex items-start gap-2 text-sm">
              {s!.valid ? (
                <CheckCircle2 className="mt-0.5 size-4 text-brand-600" />
              ) : (
                <AlertTriangle className="mt-0.5 size-4 text-amber-600" />
              )}
              <p>
                {s!.valid ? 'Posting to ' : 'Slack stopped accepting messages for '}
                <span className="font-semibold">{s!.channelName}</span> in{' '}
                <span className="font-semibold">{s!.teamName}</span>
                <span className="block text-xs text-muted">Connected {formatWhen(s!.connectedAt)}</span>
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {s!.valid ? (
                <Button
                  variant="secondary"
                  loading={test.isPending}
                  onClick={() => test.mutate(undefined, { onSuccess: () => toast.success(`Test message sent to ${s!.channelName}`) })}
                >
                  <BellRing className="size-4" /> Send test message
                </Button>
              ) : (
                <Button onClick={connect}>
                  <Slack className="size-4" /> Reconnect Slack
                </Button>
              )}
              <Button
                variant="ghost"
                loading={disconnect.isPending}
                onClick={() => disconnect.mutate(undefined, { onSuccess: () => toast('Slack disconnected') })}
              >
                <Unplug className="size-4" /> Disconnect
              </Button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

export function SettingsPage() {
  const [params, setParams] = useSearchParams();

  // Show the OAuth outcome once, then drop it from the URL.
  useEffect(() => {
    const key = params.get('slack');
    if (!key) return;
    const r = RESULTS[key] ?? RESULTS.error!;
    if (r.kind === 'success') toast.success(r.text);
    else if (r.kind === 'error') toast.error(r.text);
    else toast(r.text);
    setParams({}, { replace: true });
  }, [params, setParams]);

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
      <p className="mb-6 text-sm text-muted">Integrations and notifications.</p>
      <SlackCard />
    </div>
  );
}
